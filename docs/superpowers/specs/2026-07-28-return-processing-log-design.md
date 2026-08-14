# 반품 처리기록(처리 로그) 탭 설계

## 배경

`ReturnsPage.jsx`의 "판매자 대기"(`seller`)와 "교환판매자"(`exchange_seller`) 큐는 여러 처리 버튼(환불요청,
사유변경, 이지어드민 입고처리, 김승일보내기, 교환처리 실행 등)을 제공하지만, 처리된 항목이 "선택삭제"되거나
큐에서 빠지면 무엇을 언제 누가 처리했는지에 대한 기록이 전혀 남지 않는다. 서버 상태(`RETURN_STATES`)는
인메모리이며 재시작 시에도 사라진다.

이 기능은 두 큐에서 실제로 데이터를 변경하는("처리성") 버튼 클릭을 항목 단위로 영구 기록하고, 반품 페이지에
새 탭 "처리기록"을 추가해 조회할 수 있게 한다.

## 범위

**기록 대상 큐**: `seller`(판매자 대기), `exchange_seller`(교환판매자) — 이 두 탭에서 발생한 액션만 기록한다.
고객 대기/교환고객/미매칭 탭에서 동일한 버튼(예: 이지어드민 입고처리)을 눌러도 기록하지 않는다.

**기록 대상 버튼 (실제 처리성 액션만)**:

| 액션 키 | 버튼 레이블 | 해당 탭 |
|---|---|---|
| `ably_refund` | 에이블리 환불요청 | 판매자 대기 |
| `reason_change_sms` | 일반사유변경(문자) | 판매자 대기 |
| `reason_change_no_sms` | 일반사유변경(문자없이) | 판매자 대기 |
| `ezadmin_stockin` | 이지어드민 입고처리 | 판매자 대기, 교환판매자 |
| `kimsungil_send` | 김승일보내기 | 판매자 대기, 교환판매자 |
| `exchange_change_product` | 교환처리 실행 | 교환판매자 |
| `delete` | 선택삭제 | 판매자 대기, 교환판매자 |

**제외**: "이지어드민 정보 불러오기"(단순 조회), "바코드 출력"(서버 상태 변경 없음).

**기록 단위**: 버튼 클릭 1회 = 선택된 항목 수만큼의 행(row). 각 행은 클릭 시점의 항목 스냅샷 + 그 항목에
대한 처리 결과 상태를 담는다.

## 백엔드

### 테이블: `return_processing_log` (공유 DB, `_get_shared_db()`)

기존 `return_regathering` 테이블과 동일한 패턴으로 `backend/main.py`에 초기화 함수를 추가한다.

```sql
CREATE TABLE IF NOT EXISTS return_processing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    queue TEXT NOT NULL,          -- 'seller' | 'exchange_seller'
    action TEXT NOT NULL,         -- 위 표의 액션 키
    action_label TEXT NOT NULL,   -- 위 표의 버튼 레이블 (표시용)
    item_text TEXT NOT NULL DEFAULT '',   -- 가공데이터
    qty TEXT NOT NULL DEFAULT '',         -- 입고수량
    type TEXT NOT NULL DEFAULT '',        -- 분류
    reason TEXT NOT NULL DEFAULT '',      -- 사유
    detail_reason TEXT NOT NULL DEFAULT '', -- 상세사유
    images TEXT NOT NULL DEFAULT '[]',    -- 사진 (JSON 배열 문자열)
    ezadmin_seq TEXT NOT NULL DEFAULT '', -- SEQ
    status TEXT NOT NULL DEFAULT ''       -- 처리 결과 (예: '완료', '실패: ...')
)
```

### 엔드포인트 (`backend/api/returns_routes.py` 내 `build_returns_router`)

**`POST /returns/processing-log`**
- Body: `{ queue: str, action: str, action_label: str, entries: [{ item_text, qty, type, reason, detail_reason, images, ezadmin_seq, status }] }`
- `entries` 각 원소를 한 행씩 insert. `username`은 `Depends(get_current_user)`, `created_at`은 서버에서 KST로 생성.
- 프론트에서 각 처리 액션이 끝난 직후 fire-and-forget으로 호출 (실패해도 사용자 플로우를 막지 않음).
- 응답: `{ ok: true }`

**`GET /returns/processing-log`**
- Query: `queue`(선택), `action`(선택), `date_from`(선택, `YYYY-MM-DD`), `date_to`(선택), `q`(선택, `item_text`/`ezadmin_seq` 부분 일치 검색), `limit`(기본 200)
- 반환: `{ items: [...] }`, `created_at` 내림차순
- 필터는 SQL `WHERE`절에서 파라미터 바인딩으로 처리 (SQL 인젝션 방지).

## 프론트엔드 (`src/components/Barcode/ReturnsPage.jsx`)

### 로깅 헬퍼

```js
const logProcessingActions = async (queue, action, actionLabel, entries) => {
    if (!entries || !entries.length) return;
    try {
        await fetch(`${API}/returns/processing-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ queue, action, action_label: actionLabel, entries }),
        });
    } catch {
        // 로깅 실패는 조용히 무시 (사용자 플로우를 막지 않음)
    }
};
```

각 항목의 스냅샷은 `{ item_text: item.item_text, qty: item.qty, type: item.type, reason: item.reason, detail_reason: item.detail_reason, images: item.images || [], ezadmin_seq: item.ezadmin_seq, status }` 형태로 만든다.

### 훅 지점

1. **`handleAblyRefundSubmit`**: `data.results` 처리 후, 각 결과에 대응하는 원본 item과 매칭해
   `logProcessingActions('seller', 'ably_refund', '에이블리 환불요청', entries)` 호출. `status`는
   `r.ok ? '완료' : `실패: ${r.error || ''}``.
2. **`handleConfirmReasonChangeWithSms`**: 위와 동일한 방식, `reason_change_sms` / `일반사유변경(문자)`.
3. **`handleReasonChangeWithoutSms`**: `reason_change_no_sms` / `일반사유변경(문자없이)`.
4. **`handleEzadminReceiveStock(selectedItems, queue)`**: 함수 시그니처에 `queue` 파라미터 추가 (호출부에서
   `'seller'` / `'exchange_seller'` / `'customer'` 전달). `queue`가 `seller` 또는 `exchange_seller`일 때만
   `data.results` 기준으로 로깅 (`ezadmin_stockin` / `이지어드민 입고처리`).
5. **`handleSendToKimsungil(selectedItems, queue)`**: 위와 동일하게 `queue` 파라미터 추가, 판매자
   대기/교환판매자 호출부에서만 로깅 (`kimsungil_send` / `김승일보내기`). 이 핸들러는 개별 fetch 루프이므로
   각 항목의 성공/실패를 그대로 status에 반영.
6. **`handleExecuteExchangeChangeProduct(queue, ids)`**: `queue === 'seller'`(=교환판매자 탭)일 때만
   `exchange_change_product` / `교환처리 실행` 로깅. 대상 item은 `queues.exchange_seller`에서 `ids`로 조회.
7. **`handleDeleteSelected`**: 시그니처를 `(selectedIds, setSelectedIds, queueKey, items)`로 확장.
   `queueKey`가 `seller`/`exchange_seller`일 때만, 삭제 대상 항목들을 `status: '삭제됨'`으로 로깅 (API 성공 후).
   `renderQueueTab`이 `queueKey`를 받아 이 함수에 전달하도록 시그니처를 `(items, selectedIds, setSelectedIds, extraActions, showSmsAction, queueKey)`로 확장.

호출부 수정 대상: seller 탭 `renderQueueTab(queues.seller, ..., true, 'seller')`, exchange_seller 탭의
`renderQueueTab(queues.exchange_seller, ..., 'exchange_seller')`, 그리고 두 탭 내부의
`handleEzadminReceiveStock(...)` / `handleSendToKimsungil(...)` / `handleExecuteExchangeChangeProduct(...)` 호출에
`queue` 인자를 추가.

### 새 탭 "처리기록"

- 탭 목록(`tabRow`)에 `['processing_log', '처리기록']` 추가.
- 신규 state: `processingLog`(배열), `processingLogLoading`, `logFilterQueue`, `logFilterAction`,
  `logFilterDateFrom`, `logFilterDateTo`, `logFilterSearch`.
- `activeTab === 'processing_log'`가 되면 `useEffect`로 목록을 조회 (regather 탭과 동일 패턴).
- 필터 바: 판매자유형 select(전체/판매자 대기/교환판매자), 버튼종류 select(전체 + 위 7개 액션), 기간
  `date` input 2개(from/to), 검색어 텍스트 input, "조회" 버튼.
- 테이블 컬럼: 일시, 판매자유형, 버튼, 가공데이터, 입고수량, 분류, 사유, 상세사유, 사진(썸네일, 클릭 시
  기존 `zoomImage` 재사용), SEQ, 상태, 처리자.

## 에러 처리

- 로깅 POST 실패는 사용자에게 노출하지 않는다 (조용히 무시) — 로깅이 본 업무 흐름을 막아서는 안 됨.
- 처리기록 조회 실패 시 기존 패턴대로 `pageStyles.empty` 문구 표시.

## 테스트 방침

- 백엔드: `backend/tests/`에 `test_returns_processing_log.py` 추가 — insert 후 필터(queue/action/date/q)별 조회
  검증, SQL 파라미터 바인딩 확인.
- 프론트: 별도 자동화 테스트 없음 (기존 관례상 이 페이지는 수동 테스트). 브라우저에서 각 버튼 클릭 후
  처리기록 탭에 항목이 뜨는지, 고객 대기 탭에서 같은 버튼을 눌렀을 때는 기록되지 않는지 수동 확인.
