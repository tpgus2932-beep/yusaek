# 반품 판매자대기: 일반사유변경 버튼 + 이지데스크 문자 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 반품 판매자대기 탭에 "일반사유로변경" 일괄처리 버튼과 행별 이지데스크 문자 전송 버튼을 추가하고, 사이드메뉴 "문자" 페이지에도 이지데스크 전송 버튼을 추가한다.

**Architecture:** 백엔드 `returns_routes.py`에 신규 엔드포인트 `POST /returns/ably-change-reason-submit`을 추가한다 (기존 `/returns/ably-refund-submit`을 기반으로, `cancel_reason` 변경 PUT 호출을 앞에 추가). `/returns/load-ably-api`가 큐 아이템을 만들 때 `buyer_tel` 필드를 추가로 옮겨 담아, 별도 API 호출 없이 판매자대기 행에서 구매자 전화번호를 바로 쓸 수 있게 한다. 이지데스크 문자 발송은 새 백엔드 로직 없이 기존 `POST /return-automation/reply-sms`를 프론트엔드 두 곳(`ReturnsPage.jsx`, `SMSPage.jsx`)에서 재사용한다.

**Tech Stack:** FastAPI (Python, `backend/api/returns_routes.py`), React (`src/components/Barcode/ReturnsPage.jsx`, `src/components/SMS/SMSPage.jsx`), pytest + respx (백엔드 테스트), 프론트엔드는 자동화 테스트 없음(수동 브라우저 확인 + `npm run lint`).

## Global Constraints

- 사유변경은 항상 고정값 `cancel_reason: 31`을 보낸다 (HAR에서 캡처된 값 그대로, 다른 값 선택 UI는 만들지 않는다).
- 이지데스크 세션(PHPSESSID) 설정 UI는 새로 만들지 않는다 — 세션 만료 시 "테스트 > 자동화 대시보드에서 세션을 재설정해주세요" 안내 메시지만 표시한다.
- 이지데스크 문자 전송은 기존 `POST /return-automation/reply-sms` 엔드포인트만 재사용한다 — 새 백엔드 발송 로직을 만들지 않는다.
- 판매자대기(`seller`) 탭에만 적용한다 — 고객대기/교환 등 다른 탭은 건드리지 않는다.
- 기존 `/returns/ably-refund-submit`, `renderTable`, `renderQueueTab`의 동작(파라미터 없이 호출하는 기존 호출부 포함)을 깨지 않는다.

---

### Task 1: 백엔드 — `buyer_tel`을 판매자대기 큐 아이템까지 전달

**Files:**
- Modify: `backend/api/returns_routes.py:737-753` (`/returns/load-ably-api` 원본 아이템 캡처)
- Modify: `backend/api/returns_routes.py:773-792` (`rows.append` — df2로 만들어지는 DataFrame 행)
- Modify: `backend/api/returns_routes.py:1527-1546` (`/returns/scan` 큐 아이템 dict 생성)
- Test: `backend/tests/test_returns_buyer_tel.py` (신규)

**Interfaces:**
- Consumes: 기존 `build_returns_router` 팩토리, `ReturnState` (`services/returns_utils.py`)
- Produces: `/returns/load-ably-api` 응답 이후 `state.df2`에 `BUYER_TEL` 컬럼 추가, `/returns/scan`으로 만들어지는 큐 아이템(`state.queue_seller`/`queue_customer`/`queue_unmatched`)에 `"buyer_tel": str` 필드 추가. Task 3(문자 버튼)은 이 `item.buyer_tel`을 그대로 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_returns_buyer_tel.py`를 새로 만든다:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import pandas as pd
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import build_returns_router
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _load_return_state_from_payload,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_state_to_payload,
    _return_status,
)


def _make_client():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
            get_return_state=_get_return_state,
            get_db=lambda: None,
            get_setting=lambda key: None,
            return_status=_return_status,
            return_queue_payload=_return_queue_payload,
            return_rows=_return_rows,
            return_state_to_payload=_return_state_to_payload,
            load_return_state_from_payload=_load_return_state_from_payload,
            load_return_cost_base=lambda *a, **k: None,
            load_cost_base_df=lambda *a, **k: None,
            save_cost_base_df=lambda *a, **k: None,
            read_return_excel=_read_return_excel,
            clean_invoice=_clean_invoice,
            clean_product_name=_clean_product_name,
            lowercase_size_words=_lowercase_size_words,
            option_slash_to_space=_option_slash_to_space,
            clean_qty=_clean_qty,
            normalize_spaces=_normalize_spaces,
            reason_type=_reason_type,
            normalize_key=_normalize_key,
            content_disposition=lambda filename: f'attachment; filename="{filename}"',
            return_allowed_exts={".xlsx", ".xls"},
        )
    )
    return TestClient(app), state


@respx.mock
def test_load_ably_api_captures_buyer_tel_into_df2():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    respx.get("https://api.a-bly.com/seller/order_cancels/").mock(
        return_value=httpx.Response(
            200,
            json={
                "max_page_number": 1,
                "order_cancels": [
                    {
                        "sno": 999,
                        "refund_bank_account_holder": "홍길동",
                        "refund_bank_account_number": "1234567890",
                        "refund_bank_sno": 5,
                        "order_items": [
                            {
                                "sno": 111,
                                "cancel_reason": 30,
                                "goods_name": "테스트 상품",
                                "option_info": "블랙/M",
                                "ea": 1,
                                "invoice": "1111111111",
                                "return_delivery_fee": -3000,
                                "user_comment": "",
                                "cancel_images": [],
                                "order_sno": 555,
                                "buyer_tel": "010-1234-5678",
                            }
                        ],
                    }
                ],
            },
        )
    )

    client, state = _make_client()
    res = client.post("/returns/load-ably-api")

    assert res.status_code == 200
    assert state.df2 is not None
    assert not state.df2.empty
    assert state.df2.iloc[0]["BUYER_TEL"] == "010-1234-5678"


def test_scan_populates_buyer_tel_on_seller_queue_item():
    client, state = _make_client()
    state.map_d_to_e = {"999000111": "999000111"}
    state.df2 = pd.DataFrame([{
        "F_name": "테스트 상품", "G_opt": "블랙 m", "QTY": "1",
        "ITEM_TEXT": "테스트 상품 블랙 m", "REASON_TYPE": "판매자",
        "M_clean": "999000111", "DETAIL_REASON": "단순변심", "USER_COMMENT": "",
        "REQUEST_NO": "999", "ITEM_SNO": 111,
        "REFUND_HOLDER": "홍길동", "REFUND_ACCOUNT": "1234567890", "REFUND_BANK_SNO": 5,
        "BUYER_TEL": "010-1234-5678",
        "ORDER_NO": "555", "CANCEL_IMAGES": [], "OPTION_CODE": "", "GOODS_NAME": "테스트 상품", "OPTION_RAW": "블랙/m",
    }])
    state.df2_index = {"999000111": [0]}

    res = client.post("/returns/scan", json={"barcode": "999000111"})

    assert res.status_code == 200
    assert len(state.queue_seller) == 1
    assert state.queue_seller[0]["buyer_tel"] == "010-1234-5678"
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_buyer_tel.py -v`
Expected: 두 테스트 모두 FAIL — `state.df2.iloc[0]["BUYER_TEL"]`에서 `KeyError: 'BUYER_TEL'`, `state.queue_seller[0]["buyer_tel"]`에서 `KeyError: 'buyer_tel'`

- [ ] **Step 3: `/returns/load-ably-api`에서 buyer_tel 캡처**

`backend/api/returns_routes.py`의 아래 블록(현재 732~753행 부근):

```python
                    for cancel in cancels:
                        cancel_sno        = str(cancel.get("sno") or "")
                        refund_holder     = str(cancel.get("refund_bank_account_holder") or "")
                        refund_account    = str(cancel.get("refund_bank_account_number") or "")
                        refund_bank_sno   = cancel.get("refund_bank_sno")
                        for item in cancel.get("order_items", []):
                            item["_cancel_reason"]   = item.get("cancel_reason")
                            item["_cancel_sno"]      = cancel_sno
                            item["_item_sno"]        = item.get("sno")
                            item["_refund_holder"]   = refund_holder
                            item["_refund_account"]  = refund_account
                            item["_refund_bank_sno"] = refund_bank_sno
```

을 아래로 교체:

```python
                    for cancel in cancels:
                        cancel_sno        = str(cancel.get("sno") or "")
                        refund_holder     = str(cancel.get("refund_bank_account_holder") or "")
                        refund_account    = str(cancel.get("refund_bank_account_number") or "")
                        refund_bank_sno   = cancel.get("refund_bank_sno")
                        for item in cancel.get("order_items", []):
                            item["_cancel_reason"]   = item.get("cancel_reason")
                            item["_cancel_sno"]      = cancel_sno
                            item["_item_sno"]        = item.get("sno")
                            item["_refund_holder"]   = refund_holder
                            item["_refund_account"]  = refund_account
                            item["_refund_bank_sno"] = refund_bank_sno
                            # buyer_tel/receiver_tel은 order_item 단위 필드다 (cancel
                            # 최상위가 아님 - 실제 API 응답으로 확인됨, HAR 캡처 기준).
                            item["_buyer_tel"]       = str(item.get("buyer_tel") or item.get("receiver_tel") or "")
```

- [ ] **Step 4: `rows.append`에 `BUYER_TEL` 컬럼 추가**

같은 파일의 아래 블록(현재 773~792행 부근):

```python
            rows.append({
                "F_name":         f_name,
                "G_opt":          g_opt,
                "QTY":            qty,
                "ITEM_TEXT":      normalize_spaces(f"{f_name} {g_opt}"),
                "REASON_TYPE":    rtype,
                "M_clean":        m_clean,
                "DETAIL_REASON":  detail_reason,
                "USER_COMMENT":   user_comment,
                "REQUEST_NO":     item.get("_cancel_sno", ""),
                "ITEM_SNO":       item.get("_item_sno"),
                "REFUND_HOLDER":  item.get("_refund_holder", ""),
                "REFUND_ACCOUNT": item.get("_refund_account", ""),
                "REFUND_BANK_SNO": item.get("_refund_bank_sno"),
                "ORDER_NO":       item.get("_order_no", ""),
                "CANCEL_IMAGES":  item.get("_cancel_images") or [],
                "OPTION_CODE":    str(item.get("option_stock_sync_code") or ""),
                "GOODS_NAME":     f_name,
                "OPTION_RAW":     str(item.get("option_info") or "").strip(),
            })
```

을 아래로 교체 (`BUYER_TEL` 한 줄 추가):

```python
            rows.append({
                "F_name":         f_name,
                "G_opt":          g_opt,
                "QTY":            qty,
                "ITEM_TEXT":      normalize_spaces(f"{f_name} {g_opt}"),
                "REASON_TYPE":    rtype,
                "M_clean":        m_clean,
                "DETAIL_REASON":  detail_reason,
                "USER_COMMENT":   user_comment,
                "REQUEST_NO":     item.get("_cancel_sno", ""),
                "ITEM_SNO":       item.get("_item_sno"),
                "REFUND_HOLDER":  item.get("_refund_holder", ""),
                "REFUND_ACCOUNT": item.get("_refund_account", ""),
                "REFUND_BANK_SNO": item.get("_refund_bank_sno"),
                "BUYER_TEL":      item.get("_buyer_tel", ""),
                "ORDER_NO":       item.get("_order_no", ""),
                "CANCEL_IMAGES":  item.get("_cancel_images") or [],
                "OPTION_CODE":    str(item.get("option_stock_sync_code") or ""),
                "GOODS_NAME":     f_name,
                "OPTION_RAW":     str(item.get("option_info") or "").strip(),
            })
```

같은 함수 아래쪽의 빈 DataFrame 컬럼 목록(현재 794~795행 부근)도 함께 갱신:

```python
        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "REASON_TYPE", "M_clean", "DETAIL_REASON", "USER_COMMENT", "REQUEST_NO", "ITEM_SNO", "REFUND_HOLDER", "REFUND_ACCOUNT", "REFUND_BANK_SNO", "ORDER_NO", "CANCEL_IMAGES", "OPTION_CODE", "GOODS_NAME", "OPTION_RAW"])
```

을 아래로 교체:

```python
        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "REASON_TYPE", "M_clean", "DETAIL_REASON", "USER_COMMENT", "REQUEST_NO", "ITEM_SNO", "REFUND_HOLDER", "REFUND_ACCOUNT", "REFUND_BANK_SNO", "BUYER_TEL", "ORDER_NO", "CANCEL_IMAGES", "OPTION_CODE", "GOODS_NAME", "OPTION_RAW"])
```

- [ ] **Step 5: 테스트 재실행 → 1번째 테스트만 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_buyer_tel.py -v`
Expected: `test_load_ably_api_captures_buyer_tel_into_df2` PASS, `test_scan_populates_buyer_tel_on_seller_queue_item` 여전히 FAIL (`buyer_tel` 키 없음)

- [ ] **Step 6: `/returns/scan` 큐 아이템 dict에 `buyer_tel` 추가**

같은 파일의 아래 블록(현재 1527~1546행 부근):

```python
            item = {
                "id": state.next_id,
                "scan": barcode,
                "match": e_val,
                "item_text": item_text,
                "qty": qty,
                "type": rtype,
                "detail_reason":  str(row.get("DETAIL_REASON") or ""),
                "user_comment":   str(row.get("USER_COMMENT") or ""),
                "request_no":     str(row.get("REQUEST_NO") or ""),
                "item_sno":       _to_int(row.get("ITEM_SNO")),
                "refund_holder":  str(row.get("REFUND_HOLDER") or ""),
                "refund_account": str(row.get("REFUND_ACCOUNT") or ""),
                "refund_bank_sno": _to_int(row.get("REFUND_BANK_SNO")),
                "order_no":       _clean_sno(row.get("ORDER_NO")),
                "images":         list(row.get("CANCEL_IMAGES") or []),
                "option_code":    str(row.get("OPTION_CODE") or ""),
                "goods_name":     str(row.get("GOODS_NAME") or ""),
                "option_raw":     str(row.get("OPTION_RAW") or ""),
            }
```

을 아래로 교체 (`buyer_tel` 한 줄 추가):

```python
            item = {
                "id": state.next_id,
                "scan": barcode,
                "match": e_val,
                "item_text": item_text,
                "qty": qty,
                "type": rtype,
                "detail_reason":  str(row.get("DETAIL_REASON") or ""),
                "user_comment":   str(row.get("USER_COMMENT") or ""),
                "request_no":     str(row.get("REQUEST_NO") or ""),
                "item_sno":       _to_int(row.get("ITEM_SNO")),
                "refund_holder":  str(row.get("REFUND_HOLDER") or ""),
                "refund_account": str(row.get("REFUND_ACCOUNT") or ""),
                "refund_bank_sno": _to_int(row.get("REFUND_BANK_SNO")),
                "buyer_tel":      str(row.get("BUYER_TEL") or ""),
                "order_no":       _clean_sno(row.get("ORDER_NO")),
                "images":         list(row.get("CANCEL_IMAGES") or []),
                "option_code":    str(row.get("OPTION_CODE") or ""),
                "goods_name":     str(row.get("GOODS_NAME") or ""),
                "option_raw":     str(row.get("OPTION_RAW") or ""),
            }
```

- [ ] **Step 7: 테스트 재실행 → 전체 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_buyer_tel.py -v`
Expected: 두 테스트 모두 PASS

- [ ] **Step 8: 회귀 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 기존 테스트 전부 PASS (신규 2개 포함 총 개수 증가) — `/returns/excel2` 경로로 만들어지는 `df2`에는 `BUYER_TEL` 컬럼이 없으므로 `row.get("BUYER_TEL")`은 `None`이 되고 `str(None or "")`은 `""`가 되어 기존 엑셀 업로드 플로우는 그대로 안전하게 동작한다.

- [ ] **Step 9: 커밋**

```bash
git add backend/api/returns_routes.py backend/tests/test_returns_buyer_tel.py
git commit -m "feat: pass buyer_tel through to returns seller queue items"
```

---

### Task 2: 백엔드 — `/returns/ably-change-reason-submit` 신규 엔드포인트

**Files:**
- Modify: `backend/api/returns_routes.py:2576` (`returns_ably_refund_submit` 엔드포인트 뒤, `returns_ezadmin_receive_stock` 앞에 추가)
- Test: `backend/tests/test_returns_change_reason.py` (신규)

**Interfaces:**
- Consumes: 요청 바디 `{"items": [{"id", "request_no"(cancel_sno), "item_sno", "refund_holder", "refund_account", "refund_bank_sno"}, ...]}` (기존 판매자대기 큐 아이템 형태 그대로, `/returns/ably-refund-submit`과 동일한 입력 스키마)
- Produces: `POST /returns/ably-change-reason-submit` — 응답 `{"results": [{"id", "scan", "ok", "error"}], "queues": {...}}`. 성공한 항목은 `state_item["ably_reason_changed"] = True`, 실패한 항목은 `state_item["ably_reason_change_error"] = str`. Task 3(프론트 버튼)이 이 엔드포인트와 두 플래그를 그대로 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_returns_change_reason.py`를 새로 만든다:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import build_returns_router
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _load_return_state_from_payload,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_state_to_payload,
    _return_status,
)


def _make_client():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
            get_return_state=_get_return_state,
            get_db=lambda: None,
            get_setting=lambda key: None,
            return_status=_return_status,
            return_queue_payload=_return_queue_payload,
            return_rows=_return_rows,
            return_state_to_payload=_return_state_to_payload,
            load_return_state_from_payload=_load_return_state_from_payload,
            load_return_cost_base=lambda *a, **k: None,
            load_cost_base_df=lambda *a, **k: None,
            save_cost_base_df=lambda *a, **k: None,
            read_return_excel=_read_return_excel,
            clean_invoice=_clean_invoice,
            clean_product_name=_clean_product_name,
            lowercase_size_words=_lowercase_size_words,
            option_slash_to_space=_option_slash_to_space,
            clean_qty=_clean_qty,
            normalize_spaces=_normalize_spaces,
            reason_type=_reason_type,
            normalize_key=_normalize_key,
            content_disposition=lambda filename: f'attachment; filename="{filename}"',
            return_allowed_exts={".xlsx", ".xls"},
        )
    )
    return TestClient(app), state


@respx.mock
def test_change_reason_submit_calls_three_apis_in_order():
    respx.post("https://api.a-bly.com/seller/login/").mock(
        return_value=httpx.Response(200, json={"token": "tok"})
    )
    reason_route = respx.put("https://api.a-bly.com/seller/order_cancels/update_fields/").mock(
        side_effect=[httpx.Response(200, json={}), httpx.Response(200, json={})]
    )
    confirm_route = respx.put("https://api.a-bly.com/seller/order_items/request_confirm/").mock(
        return_value=httpx.Response(200, json={})
    )

    client, state = _make_client()
    item = {
        "id": 1, "scan": "111", "request_no": "64262485", "item_sno": 635340410,
        "refund_holder": "이영희", "refund_account": "1002955046694", "refund_bank_sno": 15,
    }
    state.queue_seller = [item]

    res = client.post("/returns/ably-change-reason-submit", json={"items": [item]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    assert state.queue_seller[0]["ably_reason_changed"] is True

    assert reason_route.call_count == 2
    first_call_body = json.loads(reason_route.calls[0].request.content)
    assert first_call_body["data_list"][0]["update_list"] == [{"field": "cancel_reason", "value": 31}]
    assert first_call_body["data_list"][0]["sno_list"] == [64262485]

    second_call_body = json.loads(reason_route.calls[1].request.content)
    assert second_call_body["data_list"][0]["update_list"][0] == {
        "field": "refund_bank_account_holder", "value": "이영희",
    }

    assert confirm_route.call_count == 1
    confirm_body = json.loads(confirm_route.calls[0].request.content)
    assert confirm_body["sno_list"] == [635340410]


def test_change_reason_submit_requires_items():
    client, state = _make_client()
    res = client.post("/returns/ably-change-reason-submit", json={"items": []})
    assert res.status_code == 400
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_change_reason.py -v`
Expected: `test_change_reason_submit_calls_three_apis_in_order`은 404(엔드포인트 없음)로 FAIL, `test_change_reason_submit_requires_items`도 404로 FAIL

- [ ] **Step 3: 엔드포인트 추가**

`backend/api/returns_routes.py`에서 `returns_ably_refund_submit` 함수(현재 2508~2575행)의 `return {"results": results, "queues": return_queue_payload(state)}` 바로 뒤, `@router.post("/returns/ezadmin-receive-stock")`(2577행) 바로 앞에 추가:

```python
    @router.post("/returns/ably-change-reason-submit")
    async def returns_ably_change_reason_submit(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        """선택된 반품 건의 사유를 일반사유(코드 31)로 변경한 뒤, 기존 환불 요청과
        동일하게 환불계좌를 재저장하고 환불을 확정한다 (HAR로 캡처한 3단계 순서 재현).
        """
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        state = get_return_state(user)
        by_id = {it.get("id"): it for it in state.queue_seller}
        by_id.update({it.get("id"): it for it in state.queue_customer})

        token = await _ably_login()
        hdrs = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        results = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            for item in items:
                result = {"id": item.get("id"), "scan": item.get("scan"), "ok": False, "error": None}
                state_item = by_id.get(item.get("id"))
                try:
                    cancel_sno = int(item.get("request_no") or 0)
                    item_sno   = int(item.get("item_sno") or 0)
                    if not cancel_sno or not item_sno:
                        raise ValueError("cancel_sno 또는 item_sno 없음")

                    r0 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={
                            "data_list": [{
                                "sno_list": [cancel_sno],
                                "update_list": [{"field": "cancel_reason", "value": 31}],
                            }]
                        },
                    )
                    r0.raise_for_status()

                    r1 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={
                            "data_list": [{
                                "sno_list": [cancel_sno],
                                "update_list": [
                                    {"field": "refund_bank_account_holder", "value": item.get("refund_holder", "")},
                                    {"field": "refund_bank_account_number", "value": item.get("refund_account", "")},
                                    {"field": "refund_bank_sno", "value": item.get("refund_bank_sno")},
                                ],
                            }]
                        },
                    )
                    r1.raise_for_status()

                    r2 = await client.put(
                        f"{ABLY_BASE}/seller/order_items/request_confirm/",
                        headers=hdrs,
                        json={"sno_list": [item_sno]},
                    )
                    r2.raise_for_status()
                    result["ok"] = True
                    if state_item is not None:
                        state_item["ably_reason_changed"] = True
                        state_item.pop("ably_reason_change_error", None)
                except Exception as e:
                    result["error"] = str(e)
                    if state_item is not None:
                        state_item["ably_reason_change_error"] = str(e)[:200]
                results.append(result)

        return {"results": results, "queues": return_queue_payload(state)}
```

- [ ] **Step 4: 테스트 재실행 → 전체 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_change_reason.py -v`
Expected: 두 테스트 모두 PASS

- [ ] **Step 5: 회귀 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 기존 테스트 전부 PASS (신규 2개 포함 총 개수 증가)

- [ ] **Step 6: 커밋**

```bash
git add backend/api/returns_routes.py backend/tests/test_returns_change_reason.py
git commit -m "feat: add /returns/ably-change-reason-submit endpoint"
```

---

### Task 3: 프론트엔드 — `ReturnsPage.jsx` "일반사유로변경" 일괄버튼

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: Task 2의 `POST /returns/ably-change-reason-submit`, 기존 `API`, `getAuthHeaders`, `normalizeQueues`, `setQueues`, `setMessage`, `selectedSeller`, `queues.seller`
- Produces: 상태 `reasonChangeLoading`, `reasonChangeResults`, 함수 `handleAblyChangeReasonSubmit(selectedItems)`. `renderTable`의 `hasReasonChangeStatus` 컬럼이 `item.ably_reason_changed`/`item.ably_reason_change_error`를 표시.

- [ ] **Step 1: 로딩/결과 상태 추가**

`src/components/Barcode/ReturnsPage.jsx:77` (`const [refundResults, setRefundResults] = useState(null);`) 바로 뒤에 추가:

```jsx
    const [refundResults, setRefundResults] = useState(null);
    const [reasonChangeLoading, setReasonChangeLoading] = useState(false);
    const [reasonChangeResults, setReasonChangeResults] = useState(null);
```

- [ ] **Step 2: 핸들러 추가**

`handleAblyRefundSubmit` 함수(현재 400~422행) 바로 뒤에 추가:

```jsx
    const handleAblyChangeReasonSubmit = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setReasonChangeLoading(true);
        setReasonChangeResults(null);
        setMessage('');
        try {
            const res = await fetch(`${API}/returns/ably-change-reason-submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok) throw new Error(data?.detail || '처리 실패');
            setReasonChangeResults(data.results);
            const ok = data.results.filter((r) => r.ok).length;
            setMessage(`일반사유 변경 완료: ${ok}/${data.results.length}건 성공`);
        } catch (err) {
            setMessage(err.message || '일반사유 변경 실패');
        } finally {
            setReasonChangeLoading(false);
        }
    };
```

- [ ] **Step 3: 판매자대기 탭 extraActions에 버튼 추가**

`src/components/Barcode/ReturnsPage.jsx`의 판매자대기 탭 렌더 블록(현재 1491~1526행)에서:

```jsx
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyRefundSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={refundLoading || selectedSeller.size === 0}
                                    >
                                        {refundLoading ? '처리 중...' : `에이블리 환불 요청 (${selectedSeller.size}건 선택)`}
                                    </button>
```

바로 뒤에 추가:

```jsx
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyChangeReasonSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (${selectedSeller.size}건 선택)`}
                                    </button>
```

- [ ] **Step 4: `renderTable`에 사유변경 결과 컬럼 추가**

`renderTable` 함수(현재 1158~1297행)에서 아래 줄:

```jsx
        const hasRefundStatus = items.some((item) => item.ably_refund_done || item.ably_refund_error);
```

바로 뒤에 추가:

```jsx
        const hasReasonChangeStatus = items.some((item) => item.ably_reason_changed || item.ably_reason_change_error);
```

그리고 테이블 헤더의 `{hasRefundStatus && <th>환불처리</th>}` 바로 뒤에 추가:

```jsx
                            {hasReasonChangeStatus && <th>사유변경</th>}
```

그리고 바디의 `{hasRefundStatus && (...)}` 블록(1245~1249행) 바로 뒤에 추가:

```jsx
                                {hasReasonChangeStatus && (
                                    <td style={{ color: item.ably_reason_change_error ? '#dc2626' : '#22c55e', fontWeight: item.ably_reason_changed ? 600 : 400 }}>
                                        {item.ably_reason_changed ? '✓ 완료' : item.ably_reason_change_error || ''}
                                    </td>
                                )}
```

- [ ] **Step 5: Lint 실행**

Run: `npm run lint`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add bulk reason-change button to returns seller queue tab"
```

---

### Task 4: 프론트엔드 — `ReturnsPage.jsx` 행별 "문자" 버튼 (이지데스크 전송)

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: Task 1의 `item.buyer_tel`, 기존 `POST /return-automation/reply-sms` (`{phone, msg}` → `{ok, result}` 또는 `{ok:false, need_ezdesk_session:true}`), `API`, `getAuthHeaders`, `setMessage`
- Produces: 판매자대기 탭 테이블 각 행의 "문자" 버튼 + 전송 모달. `showSmsAction` 파라미터가 추가된 `renderTable(items, selectedIds, onToggleOne, onToggleAll, showSmsAction)` / `renderQueueTab(items, selectedIds, setSelectedIds, extraActions, showSmsAction)`.

- [ ] **Step 1: 모달 상태 + 전송 핸들러 추가**

`handleAblyChangeReasonSubmit` 함수(Task 3에서 추가) 바로 뒤에 추가:

```jsx
    const [smsComposeItem, setSmsComposeItem] = useState(null);
    const [smsComposePhone, setSmsComposePhone] = useState('');
    const [smsComposeText, setSmsComposeText] = useState('');
    const [smsSendLoading, setSmsSendLoading] = useState(false);

    const openSmsCompose = (item) => {
        setSmsComposeItem(item);
        setSmsComposePhone(item.buyer_tel || '');
        setSmsComposeText('');
    };

    const closeSmsCompose = () => {
        setSmsComposeItem(null);
        setSmsComposePhone('');
        setSmsComposeText('');
    };

    const handleSendEzdeskSms = async () => {
        const phone = smsComposePhone.trim();
        const msg = smsComposeText.trim();
        if (!phone || !msg) {
            setMessage('전화번호와 문자 내용을 입력하세요.');
            return;
        }
        setSmsSendLoading(true);
        try {
            const res = await fetch(`${API}/return-automation/reply-sms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ phone, msg }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_ezdesk_session) {
                setMessage('이지데스크 세션이 만료되었습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.');
                return;
            }
            if (!res.ok || data?.ok === false) throw new Error(data?.detail || '문자 전송 실패');
            setMessage('이지데스크 문자 전송 완료');
            closeSmsCompose();
        } catch (err) {
            setMessage(err.message || '이지데스크 문자 전송 실패');
        } finally {
            setSmsSendLoading(false);
        }
    };
```

- [ ] **Step 2: `renderTable`/`renderQueueTab`에 `showSmsAction` 파라미터 추가**

`renderTable` 함수 시그니처(현재 1158행):

```jsx
    const renderTable = (items, selectedIds, onToggleOne, onToggleAll) => {
```

을 아래로 교체:

```jsx
    const renderTable = (items, selectedIds, onToggleOne, onToggleAll, showSmsAction) => {
```

같은 함수의 테이블 헤더 마지막 `{hasCsLookup && <th>에이블리CS</th>}` 바로 뒤에 추가:

```jsx
                            {showSmsAction && <th>문자</th>}
```

같은 함수의 테이블 바디, `hasCsLookup` 관련 마지막 `<td>` 블록(1278~1290행) 바로 뒤에 추가:

```jsx
                                {showSmsAction && (
                                    <td>
                                        <button
                                            type="button"
                                            className={pageStyles.secondaryBtn}
                                            onClick={() => openSmsCompose(item)}
                                        >
                                            문자
                                        </button>
                                    </td>
                                )}
```

`renderQueueTab` 함수 시그니처(현재 1299행):

```jsx
    const renderQueueTab = (items, selectedIds, setSelectedIds, extraActions) => {
```

을 아래로 교체:

```jsx
    const renderQueueTab = (items, selectedIds, setSelectedIds, extraActions, showSmsAction) => {
```

같은 함수 안의 `renderTable` 호출(현재 1326행):

```jsx
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll)}
```

을 아래로 교체:

```jsx
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll, showSmsAction)}
```

- [ ] **Step 3: 판매자대기 탭 호출부에 `true` 전달**

Task 3까지 적용한 뒤 판매자대기 탭 렌더 블록(현재 1491~1531행 부근)은 아래와 같은 상태다:

```jsx
                            {activeTab === 'seller' && renderQueueTab(queues.seller, selectedSeller, setSelectedSeller, (
                                <>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyRefundSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={refundLoading || selectedSeller.size === 0}
                                    >
                                        {refundLoading ? '처리 중...' : `에이블리 환불 요청 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyChangeReasonSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleEzadminReceiveStock(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={stockinLoading || selectedSeller.size === 0}
                                    >
                                        {stockinLoading ? '처리 중...' : `이지어드민 입고처리 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleSendToKimsungil(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={kimsungilSendLoading || selectedSeller.size === 0}
                                    >
                                        {kimsungilSendLoading ? '처리 중...' : `김승일보내기 (${selectedSeller.size}건 선택)`}
                                    </button>
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handlePrintBarcodesOnly(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={labelPrintLoading || selectedSeller.size === 0}
                                    >
                                        {labelPrintLoading ? '처리 중...' : `바코드 출력 (${selectedSeller.size}건 선택)`}
                                    </button>
                                </>
                            ))}
```

마지막 줄만 아래로 교체 (`renderQueueTab(...)` 호출의 다섯 번째 인자로 `true` 추가, 그 위 버튼 5개는 전혀 손대지 않는다):

```jsx
                            ), true)}
```

다른 탭 호출부(`all`, `exchange_seller`, `exchange_customer`, `unmatched`, `customer`)는 `showSmsAction` 인자를 넘기지 않으므로 `undefined`(=false)로 유지되어 문자 버튼이 나타나지 않는다.

- [ ] **Step 4: 문자 작성 모달 JSX 추가**

`csDetailModal` 모달 블록(현재 2085~2141행) 바로 뒤, `</div>` (컴포넌트 최상위 닫는 태그, 2142행) 바로 앞에 추가:

```jsx
            {smsComposeItem && (
                <div
                    onClick={closeSmsCompose}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(420px, 90vw)',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>이지데스크 문자 보내기</strong>
                            <button type="button" onClick={closeSmsCompose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <input
                                value={smsComposePhone}
                                onChange={(e) => setSmsComposePhone(e.target.value)}
                                placeholder="수신 전화번호"
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6 }}
                            />
                            <textarea
                                value={smsComposeText}
                                onChange={(e) => setSmsComposeText(e.target.value)}
                                placeholder="문자 내용을 입력하세요"
                                rows={4}
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, resize: 'vertical', font: 'inherit' }}
                            />
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleSendEzdeskSms}
                                disabled={smsSendLoading}
                            >
                                {smsSendLoading ? '전송 중...' : '전송'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
```

- [ ] **Step 5: Lint 실행**

Run: `npm run lint`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add per-row EzDesk SMS compose button to returns seller queue tab"
```

---

### Task 5: 프론트엔드 — `SMSPage.jsx` "이지데스크로 전송" 버튼

**Files:**
- Modify: `src/components/SMS/SMSPage.jsx`

**Interfaces:**
- Consumes: 기존 `POST /return-automation/reply-sms`, 기존 상태 `receivers`, `msg`, `setSendResult`, `API`, `getAuthHeaders`
- Produces: 함수 `handleSendEzdesk`, 액션 로우에 "이지데스크로 전송" 버튼

- [ ] **Step 1: 전송 로딩 상태 + 핸들러 추가**

`src/components/SMS/SMSPage.jsx:87` (`const [sending, setSending] = useState(false);`) 바로 뒤에 추가:

```jsx
  const [sending, setSending] = useState(false);
  const [ezdeskSending, setEzdeskSending] = useState(false);
```

`handleSend` 함수(현재 303~386행) 바로 뒤에 추가:

```jsx
  // ─── 이지데스크로 전송 (템플릿/작성 내용을 그대로 이지데스크로) ───
  const handleSendEzdesk = async () => {
    if (!receivers.length) { setSendResult({ ok: false, msg: '수신번호를 입력하세요.' }); return; }
    if (receivers.length > 1) { setSendResult({ ok: false, msg: '이지데스크 전송은 한 번에 한 명에게만 가능합니다.' }); return; }
    if (!msg.trim()) { setSendResult({ ok: false, msg: '메시지 내용을 입력하세요.' }); return; }
    setEzdeskSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`${API}/return-automation/reply-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ phone: receivers[0], msg }),
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (data?.need_ezdesk_session) {
        setSendResult({ ok: false, msg: '이지데스크 세션이 만료되었습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.' });
        return;
      }
      if (!res.ok || data?.ok === false) {
        setSendResult({ ok: false, msg: data?.detail || '이지데스크 전송 실패' });
        return;
      }
      setSendResult({ ok: true, msg: '이지데스크로 전송 완료' });
    } catch (err) {
      setSendResult({ ok: false, msg: err.message ? `오류: ${err.message}` : '알 수 없는 오류' });
    } finally {
      setEzdeskSending(false);
    }
  };
```

- [ ] **Step 2: 액션 로우에 버튼 추가**

`src/components/SMS/SMSPage.jsx:845~851`:

```jsx
            <div className={styles.actionRow}>
              <button className={styles.primaryBtn} onClick={handleSend} disabled={sending}>
                <Send size={15} />
                {sending ? '전송 중...' : (rdate ? '예약 발송' : '발송')}
              </button>
              {testMode && <span className={styles.hint}>테스트 모드 ON</span>}
            </div>
```

을 아래로 교체:

```jsx
            <div className={styles.actionRow}>
              <button className={styles.primaryBtn} onClick={handleSend} disabled={sending}>
                <Send size={15} />
                {sending ? '전송 중...' : (rdate ? '예약 발송' : '발송')}
              </button>
              <button className={styles.secondaryBtn} onClick={handleSendEzdesk} disabled={ezdeskSending}>
                <Send size={15} />
                {ezdeskSending ? '전송 중...' : '이지데스크로 전송'}
              </button>
              {testMode && <span className={styles.hint}>테스트 모드 ON</span>}
            </div>
```

- [ ] **Step 3: Lint 실행**

Run: `npm run lint`
Expected: 에러 없음

- [ ] **Step 4: 커밋**

```bash
git add src/components/SMS/SMSPage.jsx
git commit -m "feat: add EzDesk send button to SMS page"
```

---

### Task 6: 수동 브라우저 검증

**Files:** 없음 (검증 전용 태스크)

- [ ] **Step 1: 백엔드 개발 서버 실행**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000`

- [ ] **Step 2: 프론트엔드 개발 서버 실행**

Run: `npm run dev`

- [ ] **Step 3: 반품 판매자대기 탭 확인**

`http://localhost:5173` 접속 → 로그인 → 사이드메뉴 "반품" → "전체 API 불러오기"로 실제 데이터를 로드하고 바코드를 스캔해 판매자대기 큐에 항목을 쌓는다 (또는 미리 반품 접수된 실제 건이 있으면 그걸로 확인).

1. 판매자대기 탭에서 "일반사유로변경 (N건 선택)" 버튼이 보이는지 확인.
2. 항목 1개를 체크하고 버튼 클릭 → 에이블리 셀러센터에서 해당 건의 사유가 바뀌고 환불이 확정됐는지 확인, 테이블에 "✓ 완료"가 표시되는지 확인.
3. 같은 탭의 각 행에 "문자" 버튼이 보이는지 확인 → 클릭 시 전화번호가 자동으로 채워진 모달이 뜨는지 확인 (구매자 전화번호가 없는 건은 빈 칸으로 뜨는지도 확인).
4. 문자 내용을 입력하고 전송 → 실제 수신번호로 문자가 도착하는지 확인. 이지데스크 세션이 없는 상태에서는 안내 메시지가 뜨는지 확인.

- [ ] **Step 4: SMS 페이지 확인**

사이드메뉴 "문자 발송" → 템플릿 패널에서 템플릿 "적용" → 수신번호 1개 입력 → "이지데스크로 전송" 버튼 클릭 → 실제 수신 확인. 수신번호를 2개 이상 입력한 상태로 누르면 안내 메시지가 뜨는지 확인.

- [ ] **Step 5: 문제가 없으면 완료 보고, 문제가 있으면 해당 태스크로 돌아가 수정**
