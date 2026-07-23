# 반품 스캔 항목 개별 삭제 기능 설계

- 날짜: 2026-07-23
- 대상 페이지: `src/components/Barcode/ReturnsPage.jsx` (사이드메뉴 "반품")
- 관련 백엔드: `backend/api/returns_routes.py`, `backend/services/returns_utils.py`

## 배경

반품 페이지에는 스캔된 항목이 여러 탭(전체 / 판매자 / 구매자 / 미매칭 / 교환-판매자 / 교환-구매자)에
큐 형태로 쌓인다. 현재 삭제 관련 기능은 두 가지뿐이다.

- **"방금 찍은거 삭제"**(undo): 직전 스캔에서 추가된 항목만 되돌림 (`state.last_added_ids` 기준)
- **"초기화"**(reset): 모든 큐를 완전히 비움

특정 항목 하나(또는 여러 개)를 골라서만 지우는 기능이 없다. "구매자" 탭에는 이미 체크박스가 있지만
이건 삭제용이 아니라 에이블리 환불 요청 대상 선택용이다.

## 목표

모든 탭에서 항목을 체크박스로 개별 선택한 뒤 "선택 삭제" 버튼으로 지울 수 있게 한다.

## 데이터 모델 확인 사항

스캔 시 백엔드는 동일한 `item` dict(같은 `id`)를 `all_items`와 매칭된 개별 큐
(`queue_seller` / `queue_customer` / `queue_unmatched` / `queue_exchange_seller` /
`queue_exchange_customer`) 양쪽에 동시에 append한다 (`returns_routes.py`의 `/returns/scan` 핸들러).
따라서 삭제도 **id 기준으로 모든 큐 리스트를 순회하며 제거**해야 "전체" 탭과 개별 탭 간
데이터 불일치가 생기지 않는다. 이는 기존 undo(`/returns/undo`)가 쓰는 것과 동일한 패턴이다.

## 백엔드 설계

`returns_routes.py`에 새 엔드포인트를 추가한다 (undo/reset 엔드포인트 근처).

```python
class DeleteReturnItemsPayload(BaseModel):
    ids: list[int]

@router.post("/delete-items")
async def delete_return_items(
    payload: DeleteReturnItemsPayload,
    user: str = Depends(get_current_user),
):
    state = _get_return_state(user)
    remove_ids = set(payload.ids)
    if not remove_ids:
        raise HTTPException(status_code=400, detail="삭제할 항목이 없습니다.")
    for attr in [
        "queue_seller", "queue_customer", "queue_unmatched",
        "queue_exchange_seller", "queue_exchange_customer",
        "queue_exchange", "all_items",
    ]:
        queue = getattr(state, attr)
        setattr(state, attr, [it for it in queue if it.get("id") not in remove_ids])
    return {"success": True, "data": {"queues": return_queue_payload(state)}}
```

- 인메모리 상태(`RETURN_STATES[user]`)만 수정한다. DB(`return_saved_states`)나 원가베이스 엑셀은
  건드리지 않는다 — 영속화는 기존 "임시저장" 흐름에 그대로 맡긴다.
- `ids`가 비어 있으면 400 에러.
- 존재하지 않는 id가 섞여 있어도 에러 없이 무시(필터링이므로 자연히 처리됨).

## 프론트엔드 설계

### 선택 상태

- 새 탭(`all`, `seller`, `unmatched`, `exchange_seller`, `exchange_customer`)마다 별도의
  `Set` state를 추가한다: `selectedAll`, `selectedSeller`, `selectedUnmatched`,
  `selectedExchangeSeller`, `selectedExchangeCustomer`.
- `customer` 탭은 기존 `selectedCustomer` state를 그대로 재사용한다(별도 체크박스 열을
  추가하지 않음). 삭제 버튼도 기존 에이블리 환불요청 버튼 옆에 추가한다.

### 렌더링

- 공용 `renderTable(items)` 함수의 시그니처를 `renderTable(items, selectedIds, onToggleOne, onToggleAll)`로
  확장하여 체크박스 열(헤더의 전체선택 + 행별 체크박스)을 추가한다. `all`, `seller`, `unmatched`,
  `exchange_seller`, `exchange_customer` 탭이 이 함수를 호출할 때 각자의 selection state를 전달한다.
- `customer` 탭 전용 렌더 블록(1102~1164줄 부근)은 기존 체크박스 UI를 그대로 쓰고, 삭제 버튼만 추가한다.

### 삭제 동작

- 각 탭 상단 툴바에 **"선택 삭제 (N)"** 버튼 추가. `N === 0`이면 비활성화.
- 클릭 시 `window.confirm(`선택한 ${N}개 항목을 삭제할까요?`)` 확인 후:
  1. `POST {API}/returns/delete-items` 에 `{ ids: [...selectedIds] }` 전송
  2. 응답의 `data.queues`로 `setQueues(normalizeQueues(...))` 갱신
  3. 해당 탭의 selection Set을 비움
- 실패 시 기존 `handleUndo`/`handleReset` 패턴과 동일하게 에러 메시지를 `setMessage`(또는 `alert`)로
  표시하고, 선택 상태는 유지해서 재시도 가능하게 한다.

## 범위 밖 (Out of scope)

- DB 스냅샷(`return_saved_states`) 자동 갱신 — 필요하면 사용자가 기존 "임시저장" 버튼을 다시 누르면 됨.
- undo/reset 버튼 동작 변경 — 그대로 유지.
- 원가베이스 엑셀 파일 수정 — 무관.
