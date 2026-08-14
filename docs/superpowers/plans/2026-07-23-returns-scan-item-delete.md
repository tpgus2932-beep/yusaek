# 반품 스캔 항목 개별 체크 삭제 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 반품 페이지의 모든 탭(전체/판매자/구매자/미매칭/교환-판매자/교환-구매자)에서 스캔된 항목을 체크박스로 개별 선택해서 삭제할 수 있게 한다.

**Architecture:** 백엔드에 새 엔드포인트 `POST /returns/delete-items`를 추가해 id 목록을 받아 모든 큐 리스트(인메모리 `ReturnState`)에서 해당 id를 제거한다. 프론트엔드는 탭별로 선택 상태(`Set`)를 두고, 기존 `renderTable` 공용 렌더러에 체크박스 열을 추가한 뒤 "선택 삭제" 버튼에서 새 엔드포인트를 호출한다. "구매자" 탭은 이미 있는 `selectedCustomer` 체크박스를 그대로 재사용한다.

**Tech Stack:** FastAPI (Python, `backend/api/returns_routes.py`), React (`src/components/Barcode/ReturnsPage.jsx`), pytest (백엔드 테스트), 프론트엔드는 자동화 테스트 없음(수동 브라우저 확인 + `npm run lint`).

## Global Constraints

- 삭제는 인메모리 `ReturnState`만 수정한다. DB(`return_saved_states`)나 원가베이스 엑셀은 건드리지 않는다.
- 같은 id가 `all_items`와 매칭된 개별 큐(seller/customer/unmatched/exchange_seller/exchange_customer) 양쪽에 동시에 존재하므로, 삭제는 **모든 큐 리스트를 순회하며 id를 제거**해야 한다 (기존 `/returns/undo`와 동일한 패턴).
- 새 엔드포인트는 기존 코드 컨벤션을 따라 `payload: dict = Body(...)`를 사용한다 (이 라우터 파일에는 Pydantic `BaseModel`이 없음).
- 프론트엔드 삭제 버튼 클릭 시 반드시 `window.confirm`으로 확인 후 삭제한다.
- 기존 `renderTable`, `handleUndo`, `handleReset`의 동작은 변경하지 않는다.

---

### Task 1: 백엔드 — `/returns/delete-items` 엔드포인트

**Files:**
- Modify: `backend/api/returns_routes.py:53` (module-level helper 함수 추가, `build_returns_router` 정의 바로 앞)
- Modify: `backend/api/returns_routes.py:1562` (`returns_reset` 엔드포인트 뒤에 새 엔드포인트 추가)
- Test: `backend/tests/test_returns_delete_items.py` (신규)

**Interfaces:**
- Consumes: `services.returns_utils.ReturnState` (기존), `services.returns_utils._return_queue_payload` (기존, `build_returns_router`에는 `return_queue_payload`라는 이름으로 주입됨)
- Produces: 모듈 레벨 함수 `_remove_return_queue_ids(state, remove_ids: set[int]) -> None` — id가 `remove_ids`에 속한 항목을 `state`의 모든 큐 리스트(`queue_seller`, `queue_customer`, `queue_unmatched`, `queue_exchange_seller`, `queue_exchange_customer`, `queue_exchange`, `all_items`)에서 제거. 신규 엔드포인트 `POST /returns/delete-items` — 요청 바디 `{"ids": [int, ...]}`, 응답 `{"ok": true, "queues": {...}}` (성공) 또는 400 (`ids`가 비어있을 때).

- [ ] **Step 1: 헬퍼 함수 단위 테스트 작성 (실패 예상)**

`backend/tests/test_returns_delete_items.py` 파일을 새로 만든다:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import _remove_return_queue_ids, build_returns_router
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


def test_remove_return_queue_ids_removes_across_all_queues():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111"}
    item_b = {"id": 2, "scan": "222"}
    item_c = {"id": 3, "scan": "333"}
    state.queue_seller = [item_a]
    state.queue_customer = [item_b]
    state.queue_unmatched = [item_c]
    state.all_items = [item_a, item_b, item_c]

    _remove_return_queue_ids(state, {1, 3})

    assert state.queue_seller == []
    assert state.queue_customer == [item_b]
    assert state.queue_unmatched == []
    assert state.all_items == [item_b]


def test_remove_return_queue_ids_ignores_unknown_ids():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111"}
    state.queue_seller = [item_a]
    state.all_items = [item_a]

    _remove_return_queue_ids(state, {999})

    assert state.queue_seller == [item_a]
    assert state.all_items == [item_a]


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


def test_delete_items_endpoint_removes_from_all_queues():
    client, state = _make_client()
    item_a = {"id": 1, "scan": "111", "match": "m1", "item_text": "t1", "qty": "1", "type": "판매자"}
    item_b = {"id": 2, "scan": "222", "match": "m2", "item_text": "t2", "qty": "1", "type": "고객"}
    state.queue_seller = [item_a]
    state.queue_customer = [item_b]
    state.all_items = [item_a, item_b]

    res = client.post("/returns/delete-items", json={"ids": [1]})

    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["queues"]["seller"] == []
    assert data["queues"]["customer"] == [item_b]
    assert data["queues"]["all"] == [item_b]


def test_delete_items_endpoint_requires_ids():
    client, state = _make_client()
    res = client.post("/returns/delete-items", json={"ids": []})
    assert res.status_code == 400
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_delete_items.py -v`
Expected: `ImportError: cannot import name '_remove_return_queue_ids'` (헬퍼가 아직 없으므로 수집 단계에서 실패)

- [ ] **Step 3: 모듈 레벨 헬퍼 함수 추가**

`backend/api/returns_routes.py`에서 `def build_returns_router(` 정의(현재 53번째 줄) 바로 앞에 추가:

```python
def _remove_return_queue_ids(state, remove_ids: set) -> None:
    for attr in (
        "queue_seller", "queue_customer", "queue_unmatched",
        "queue_exchange_seller", "queue_exchange_customer",
        "queue_exchange", "all_items",
    ):
        queue = getattr(state, attr)
        setattr(state, attr, [it for it in queue if it.get("id") not in remove_ids])


def build_returns_router(
```

- [ ] **Step 4: 테스트 재실행 → 헬퍼 테스트는 통과, 엔드포인트 테스트는 여전히 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_delete_items.py -v`
Expected: `test_remove_return_queue_ids_removes_across_all_queues`, `test_remove_return_queue_ids_ignores_unknown_ids` PASS. `test_delete_items_endpoint_removes_from_all_queues`, `test_delete_items_endpoint_requires_ids` FAIL with 404 (엔드포인트가 아직 없으므로).

- [ ] **Step 5: 엔드포인트 추가**

`backend/api/returns_routes.py`의 `returns_reset` 엔드포인트(현재 1548~1562줄) 바로 뒤, `returns_build_onebe`(1564줄) 앞에 추가:

```python
    @router.post("/returns/delete-items")
    def returns_delete_items(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        raw_ids = payload.get("ids") or []
        remove_ids = {int(i) for i in raw_ids}
        if not remove_ids:
            raise HTTPException(status_code=400, detail="삭제할 항목이 없습니다.")
        _remove_return_queue_ids(state, remove_ids)
        return {"ok": True, "queues": return_queue_payload(state)}
```

- [ ] **Step 6: 테스트 재실행 → 전체 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_delete_items.py -v`
Expected: 4개 테스트 모두 PASS

- [ ] **Step 7: 회귀 확인 — 기존 반품 관련 백엔드 테스트가 깨지지 않았는지 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 기존 테스트 전부 PASS (신규 4개 포함 총 개수 증가)

- [ ] **Step 8: 커밋**

```bash
git add backend/api/returns_routes.py backend/tests/test_returns_delete_items.py
git commit -m "feat: add /returns/delete-items endpoint for selective queue item deletion"
```

---

### Task 2: 프론트엔드 — 선택 상태 + API 호출 + 체크박스 지원 테이블 (전체/판매자/미매칭/교환-판매자/교환-구매자 탭)

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: 신규 백엔드 엔드포인트 `POST /returns/delete-items` (Task 1), 기존 `normalizeQueues`, `setQueues`, `setMessage`, `API`, `getAuthHeaders`
- Produces: `deleteReturnItems(ids: number[]) -> Promise<{ok, queues}>`, `handleDeleteSelected(selectedIds: Set<number>, setSelectedIds: Function) -> Promise<void>`, `renderTable(items, selectedIds, onToggleOne, onToggleAll)` (확장된 시그니처), `renderQueueTab(items, selectedIds, setSelectedIds)` (신규) — Task 3에서 customer 탭이 `handleDeleteSelected`를 그대로 재사용한다.

- [ ] **Step 1: 선택 상태 추가**

`src/components/Barcode/ReturnsPage.jsx:67` (`const [selectedCustomer, setSelectedCustomer] = useState(new Set());`) 바로 뒤에 추가:

```jsx
    const [selectedCustomer, setSelectedCustomer] = useState(new Set());
    const [selectedAll, setSelectedAll] = useState(new Set());
    const [selectedSeller, setSelectedSeller] = useState(new Set());
    const [selectedUnmatched, setSelectedUnmatched] = useState(new Set());
    const [selectedExchangeSeller, setSelectedExchangeSeller] = useState(new Set());
    const [selectedExchangeCustomer, setSelectedExchangeCustomer] = useState(new Set());
    const [deleteLoading, setDeleteLoading] = useState(false);
```

- [ ] **Step 2: API 호출 함수 + 삭제 핸들러 추가**

`src/components/Barcode/ReturnsPage.jsx:572`의 `scanBarcode` 함수 뒤 (`addRelatedItem` 함수 앞)에 추가:

```jsx
    const deleteReturnItems = async (ids) => {
        const res = await fetch(`${API}/returns/delete-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ ids }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || '삭제 실패');
        return data;
    };
```

같은 파일의 `handleUndo` 함수(630~643줄) 바로 뒤에 추가:

```jsx
    const handleDeleteSelected = async (selectedIds, setSelectedIds) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        if (!window.confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`)) return;
        setDeleteLoading(true);
        try {
            const data = await deleteReturnItems(ids);
            setQueues(normalizeQueues(data.queues));
            setSelectedIds(new Set());
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        } finally {
            setDeleteLoading(false);
        }
    };
```

- [ ] **Step 3: `renderTable`에 체크박스 열 추가**

`src/components/Barcode/ReturnsPage.jsx:861~919`의 기존 `renderTable` 함수 전체를 아래 내용으로 교체 (체크박스 열과 `selectedIds`/`onToggleOne`/`onToggleAll` 매개변수 추가):

```jsx
    const renderTable = (items, selectedIds, onToggleOne, onToggleAll) => {
        if (!items || items.length === 0) {
            return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
        }
        const hasReason = items.some((item) => item.reason);
        const hasDetailReason = items.some((item) => item.detail_reason);
        const hasUserComment = items.some((item) => item.user_comment);
        const hasEzadminInfo = items.some((item) =>
            item.ezadmin_seq || item.old_product_id || item.new_product_id || item.ezadmin_error || item.change_product_done
        );
        const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
        return (
            <div className={pageStyles.tableWrap}>
                <table className={pageStyles.table}>
                    <thead>
                        <tr>
                            <th style={{ width: '32px', textAlign: 'center' }}>
                                <input type="checkbox" checked={allChecked} onChange={onToggleAll} />
                            </th>
                            <th>스캔송장</th>
                            <th>요청메모</th>
                            <th>가공데이터</th>
                            <th>입고수량</th>
                            <th>분류</th>
                            {hasReason && <th>사유</th>}
                            {hasDetailReason && <th>상세사유</th>}
                            {hasUserComment && <th>고객메모</th>}
                            {hasEzadminInfo && <th>SEQ</th>}
                            {hasEzadminInfo && <th>PRD_SEQ</th>}
                            {hasEzadminInfo && <th>기존상품코드</th>}
                            {hasEzadminInfo && <th>교환상품코드</th>}
                            {hasEzadminInfo && <th>상태</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((item) => (
                            <tr key={item.id} style={selectedIds.has(item.id) ? { background: 'var(--bg-secondary)' } : undefined}>
                                <td style={{ textAlign: 'center' }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(item.id)}
                                        onChange={() => onToggleOne(item.id)}
                                    />
                                </td>
                                <td>{item.scan}</td>
                                <td>{item.match}</td>
                                <td>{item.item_text}</td>
                                <td>{item.qty}</td>
                                <td>{item.type}</td>
                                {hasReason && <td>{item.reason || ''}</td>}
                                {hasDetailReason && <td>{item.detail_reason || ''}</td>}
                                {hasUserComment && <td>{item.user_comment || ''}</td>}
                                {hasEzadminInfo && <td>{item.ezadmin_seq || ''}</td>}
                                {hasEzadminInfo && <td>{item.ezadmin_prd_seq || ''}</td>}
                                {hasEzadminInfo && <td>{item.old_product_id || ''}</td>}
                                {hasEzadminInfo && <td>{item.new_product_id || ''}</td>}
                                {hasEzadminInfo && (
                                    <td style={{ color: item.ezadmin_error ? '#dc2626' : '#22c55e' }}>
                                        {item.change_product_done
                                            ? '교환처리완료'
                                            : item.ezadmin_error || (item.ezadmin_seq ? '완료' : '')}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };
```

- [ ] **Step 4: `renderQueueTab` 헬퍼 추가 (선택 삭제 버튼 + 테이블 묶음)**

방금 수정한 `renderTable` 함수 바로 뒤에 추가:

```jsx
    const renderQueueTab = (items, selectedIds, setSelectedIds) => {
        const handleToggleOne = (id) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            });
        };
        const handleToggleAll = () => {
            const allChecked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
            setSelectedIds(allChecked ? new Set() : new Set(items.map((item) => item.id)));
        };
        return (
            <>
                {items.length > 0 && (
                    <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                        <button
                            type="button"
                            className={pageStyles.secondaryBtn}
                            onClick={() => handleDeleteSelected(selectedIds, setSelectedIds)}
                            disabled={deleteLoading || selectedIds.size === 0}
                        >
                            선택 삭제 ({selectedIds.size})
                        </button>
                    </div>
                )}
                {renderTable(items, selectedIds, handleToggleOne, handleToggleAll)}
            </>
        );
    };
```

- [ ] **Step 5: 탭 렌더링 부분을 `renderQueueTab` 호출로 교체**

`src/components/Barcode/ReturnsPage.jsx:1103~1104`:

```jsx
                            {activeTab === 'all' && renderTable(queues.all)}
                            {activeTab === 'seller' && renderTable(queues.seller)}
```

을 아래로 교체:

```jsx
                            {activeTab === 'all' && renderQueueTab(queues.all, selectedAll, setSelectedAll)}
                            {activeTab === 'seller' && renderQueueTab(queues.seller, selectedSeller, setSelectedSeller)}
```

`src/components/Barcode/ReturnsPage.jsx:1168, 1171, 1196`:

```jsx
                            {activeTab === 'exchange_seller' && renderTable(queues.exchange_seller)}
                            {activeTab === 'exchange_customer' && (
                                <>
                                    {renderTable(queues.exchange_customer)}
```

을 아래로 교체:

```jsx
                            {activeTab === 'exchange_seller' && renderQueueTab(queues.exchange_seller, selectedExchangeSeller, setSelectedExchangeSeller)}
                            {activeTab === 'exchange_customer' && (
                                <>
                                    {renderQueueTab(queues.exchange_customer, selectedExchangeCustomer, setSelectedExchangeCustomer)}
```

그리고:

```jsx
                            {activeTab === 'unmatched' && renderTable(queues.unmatched)}
```

을 아래로 교체:

```jsx
                            {activeTab === 'unmatched' && renderQueueTab(queues.unmatched, selectedUnmatched, setSelectedUnmatched)}
```

- [ ] **Step 6: Lint 실행**

Run: `npm run lint`
Expected: 에러 없음 (신규로 추가한 코드에 미사용 변수/훅 규칙 위반이 없어야 함)

- [ ] **Step 7: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add per-item checkbox delete to returns queue tabs (all/seller/unmatched/exchange)"
```

---

### Task 3: 프론트엔드 — "구매자" 탭에 선택 삭제 버튼 추가 (기존 체크박스 재사용)

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: `handleDeleteSelected`, `deleteLoading`, `selectedCustomer`, `setSelectedCustomer` (모두 Task 2에서 정의됨)

- [ ] **Step 1: customer 탭 렌더 블록에 삭제 버튼 추가**

`src/components/Barcode/ReturnsPage.jsx`의 customer 탭 렌더 블록(교체 후 기준 약 1105~1167줄)에서, `return (` 다음의 최상위 엘리먼트를 `<div className={pageStyles.tableWrap}>`에서 `<>...</>` 프래그먼트로 감싸고 그 안에 삭제 버튼을 추가한다.

변경 전:

```jsx
                            {activeTab === 'customer' && (() => {
                                const items = queues.customer;
                                if (!items || items.length === 0) return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
                                const allChecked = items.length > 0 && items.every((i) => selectedCustomer.has(i.id));
                                const hasDetailReason = items.some((i) => i.detail_reason);
                                const hasUserComment = items.some((i) => i.user_comment);
                                return (
                                    <div className={pageStyles.tableWrap}>
                                        <table className={pageStyles.table}>
```

변경 후:

```jsx
                            {activeTab === 'customer' && (() => {
                                const items = queues.customer;
                                if (!items || items.length === 0) return <div className={pageStyles.empty}>데이터가 없습니다.</div>;
                                const allChecked = items.length > 0 && items.every((i) => selectedCustomer.has(i.id));
                                const hasDetailReason = items.some((i) => i.detail_reason);
                                const hasUserComment = items.some((i) => i.user_comment);
                                return (
                                    <>
                                        <div className={`${pageStyles.uploadRow} ${styles.compactActions}`}>
                                            <button
                                                type="button"
                                                className={pageStyles.secondaryBtn}
                                                onClick={() => handleDeleteSelected(selectedCustomer, setSelectedCustomer)}
                                                disabled={deleteLoading || selectedCustomer.size === 0}
                                            >
                                                선택 삭제 ({selectedCustomer.size})
                                            </button>
                                        </div>
                                        <div className={pageStyles.tableWrap}>
                                            <table className={pageStyles.table}>
```

그리고 해당 블록의 닫는 부분(현재 1165~1167줄):

변경 전:

```jsx
                                    </div>
                                );
                            })()}
```

변경 후:

```jsx
                                        </div>
                                    </>
                                );
                            })()}
```

(들여쓰기가 한 단계씩 깊어지는 것은 `<table>...</table>` 내부 JSX 전체에 적용되지만, 내용 자체는 변경하지 않는다 — 여는 태그를 `<div className={pageStyles.tableWrap}>`에서 `<>` + `<div className={pageStyles.tableWrap}>`로, 닫는 태그를 `</div>`에서 `</div>` + `</>`로 감싸기만 한다.)

- [ ] **Step 2: Lint 실행**

Run: `npm run lint`
Expected: 에러 없음

- [ ] **Step 3: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add selection delete button to returns customer tab"
```

---

### Task 4: 수동 브라우저 검증

**Files:** 없음 (검증 전용 태스크)

- [ ] **Step 1: 백엔드 개발 서버 실행**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000`

- [ ] **Step 2: 프론트엔드 개발 서버 실행**

Run: `npm run dev`

- [ ] **Step 3: 브라우저에서 반품 페이지 확인**

`http://localhost:5173` 접속 → 로그인 → 사이드메뉴 "반품" 클릭 →

1. 바코드 스캔 입력창에 임의의 값 몇 개를 입력해 스캔 큐에 항목을 쌓는다(매칭이 안 되어 "미매칭"으로 가도 무방).
2. "전체 대기", "미매칭 대기" 등 각 탭에서 체크박스가 표시되는지 확인.
3. 항목 1개를 체크하고 "선택 삭제 (1)" 버튼 클릭 → 확인창에서 "확인" → 해당 항목이 테이블에서 사라지고, "전체 대기" 탭에서도 같이 사라지는지 확인.
4. 헤더의 전체선택 체크박스로 전체 선택/해제가 되는지 확인.
5. "구매자" 탭에서 기존 체크박스로 "선택 삭제" 버튼이 동작하는지 확인 (에이블리 환불 요청 버튼과 별도로 정상 동작해야 함).
6. 취소(확인창에서 "취소") 시 삭제되지 않는지 확인.

- [ ] **Step 4: 문제가 없으면 완료 보고, 문제가 있으면 해당 태스크로 돌아가 수정**
