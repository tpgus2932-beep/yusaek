# 반품 판매자대기: 일반사유변경 버튼 + 이지데스크 문자 + SMS 페이지 이지데스크 전송

## 배경

`반품사유변경및환불.har`을 캡처해보니, 에이블리 셀러센터에서 반품 건의 사유를
바꾸고 환불을 확정하는 조작이 실제로는 3개의 API 호출로 이루어진다:

1. `PUT /seller/order_cancels/update_fields/` — `cancel_reason` 필드를 `31`로 변경
2. `PUT /seller/order_cancels/update_fields/` — 환불계좌(예금주/계좌번호/은행코드) 재저장
3. `PUT /seller/order_items/request_confirm/` — 환불 확정

이 중 2·3번은 `backend/api/returns_routes.py`의 `/returns/ably-refund-submit`
(판매자대기 탭의 기존 "에이블리 환불 요청" 버튼)이 이미 그대로 수행하고 있다.
새로 필요한 것은 1번(사유변경)뿐이며, 여기에 기존 2·3번 로직을 이어붙이면 HAR과
동일한 순서가 재현된다.

추가로, 판매자대기 탭에서 반품 건에 대해 바로 이지데스크로 문자를 보내고 싶다는
요청과, 사이드메뉴 "문자" 페이지에서도 템플릿을 골라 이지데스크로 보내고 싶다는
요청이 있었다. 이지데스크 문자 발송(`EzAdminClient.send_sms`)은 이미
`return_automation_routes.py`(`/return-automation/reply-sms`), `client_cancel_soldout_routes.py`,
`delivery_anomaly_routes.py` 세 곳에서 검증된 경로이므로, 이번 작업은 새 발송
로직을 만들지 않고 기존 `/return-automation/reply-sms` 엔드포인트를 재사용한다.

## 목표

1. 판매자대기 탭에 **"일반사유로변경 (N건 선택)"** 일괄처리 버튼 추가 — 선택된
   건들에 대해 사유변경 → 환불계좌 재저장 → 환불확정을 순서대로 처리
2. 판매자대기 탭의 각 행에 **"문자" 버튼** 추가 — 클릭 시 구매자 전화번호가
   자동으로 채워진(수정 가능) 입력창이 열리고, 자유 문구를 입력해 이지데스크로 전송
3. 사이드메뉴 "문자" 페이지(`SMSPage.jsx`)에 **"이지데스크로 전송"** 버튼 추가 —
   현재 작성/선택된 템플릿 내용과 입력된 수신번호로 이지데스크 전송

## 비범위

- 이지데스크 세션(PHPSESSID) 설정 UI 신규 추가 — 기존 "테스트 > 자동화 대시보드"의
  설정 화면을 그대로 재사용. 세션이 없거나 만료되면 안내 메시지만 표시.
- `cancel_reason=31`이 실제로 무엇을 의미하는지에 대한 검증/선택 UI — 버튼은 항상
  고정값 `31`을 보낸다 (HAR에서 캡처된 값 그대로).
- 판매자대기 탭 외 다른 탭(고객대기/교환 등)에 동일 버튼 확장 — 이번 작업은
  판매자대기(`seller`) 탭 한정.
- Aligo 문자 발송(`/sms/send`) 로직 변경 — 기존 그대로 유지, 이지데스크 전송은
  별도 버튼으로 추가만 한다.

## 프론트엔드 설계

### 1. `ReturnsPage.jsx` — "일반사유로변경" 버튼

- 판매자대기 탭 `extraActions`(약 1496~1520행)에 기존 "에이블리 환불 요청" 버튼
  옆으로 새 버튼 추가:
  ```jsx
  <button onClick={() => handleAblyChangeReasonSubmit(selectedSellerItems)} disabled={reasonChangeLoading}>
    일반사유로변경 ({selectedSeller.size}건 선택)
  </button>
  ```
- `handleAblyChangeReasonSubmit` 핸들러는 `handleAblyRefundSubmit`(400~422행)과
  동일한 구조로 작성: `POST {API}/returns/ably-change-reason-submit`에
  `{ items: selectedItems }` 전송 → 응답의 `queues`로 상태 갱신, `results`로
  성공/실패 건수 메시지 표시 (`일반사유 변경 완료: N/M건 성공`).
- 결과 표시: 기존 `hasRefundStatus` 컬럼과 같은 패턴으로 `hasReasonChangeStatus`
  컬럼을 테이블에 추가 (`item.ably_reason_changed` / `item.ably_reason_change_error`).

### 2. `ReturnsPage.jsx` — 행별 "문자" 버튼 (이지데스크)

- 판매자대기 탭 테이블(`renderTable`, 1158~1297행)에 "문자" 액션 컬럼 추가 —
  각 행에 작은 "문자" 버튼.
- 클릭 시 해당 행의 작은 인라인 편집 상태(`smsComposeId`, `smsComposeText`)를 열어
  전화번호 입력칸(기본값 `item.buyer_tel`, 수정 가능)과 메시지 textarea를 표시.
- 전송 버튼 클릭 → `POST {API}/return-automation/reply-sms`에
  `{ phone, msg }` 전송 (기존 엔드포인트 그대로 재사용, 백엔드 변경 없음).
- 응답에 `need_ezdesk_session: true`가 오면, 별도 설정 모달을 새로 만들지 않고
  "이지데스크 세션이 만료되었습니다. 테스트 > 자동화 대시보드에서 세션을
  재설정해주세요." 안내 메시지만 표시.

### 3. `SMSPage.jsx` — "이지데스크로 전송" 버튼

- 기존 전송 버튼(`334행` 부근, Aligo `/sms/send` 호출) 옆에 "이지데스크로 전송"
  버튼 추가.
- 클릭 시 현재 폼 상태의 `receiver`, `msg`를 그대로 사용해
  `POST {API}/return-automation/reply-sms`에 `{ phone: receiver, msg }` 전송
  (백엔드 신규 엔드포인트 없이 기존 것 재사용 — `receiver`는 이미 SMS 페이지에
  있는 수신번호 입력 필드를 그대로 사용).
- `need_ezdesk_session: true` 응답 시 판매자대기 탭과 동일하게 안내 메시지만
  표시 (설정은 자동화 대시보드에서).

## 백엔드 설계

### 1. 신규 라우트 `POST /returns/ably-change-reason-submit` (`returns_routes.py`)

`/returns/ably-refund-submit`(2508~2575행)을 기반으로 작성. 요청 바디는 동일하게
`{"items": [...]}`(각 item에 `id`, `request_no`(=cancel_sno), `item_sno`,
`refund_holder`, `refund_account`, `refund_bank_sno` 포함, 기존 큐 아이템 형태
그대로). 각 item마다:

```python
r0 = await client.put(
    f"{ABLY_BASE}/seller/order_cancels/update_fields/",
    headers=hdrs,
    json={"data_list": [{"sno_list": [cancel_sno], "update_list": [{"field": "cancel_reason", "value": 31}]}]},
)
r0.raise_for_status()

r1 = await client.put(  # 기존 refund_bank_* update_fields 호출 (그대로)
    ...
)
r1.raise_for_status()

r2 = await client.put(  # 기존 request_confirm 호출 (그대로)
    ...
)
r2.raise_for_status()
```

성공 시 `state_item["ably_reason_changed"] = True` (기존 `ably_refund_done`과
별개 플래그), 실패 시 `state_item["ably_reason_change_error"] = str(e)[:200]`.
`by_id` 조회 및 `state.queue_seller`/`state.queue_customer` 룩업, 응답 형태
(`{"results": [...], "queues": return_queue_payload(state)}`)는 기존
`ably-refund-submit`과 동일하게 유지.

### 2. `POST /returns/load-ably-api`에 `buyer_tel` 필드 추가 (returns_routes.py)

- 738~743행 근처, `_cancel_reason`/`_refund_holder` 등을 캡처하는 자리에
  `item["_buyer_tel"] = item.get("buyer_tel") or item.get("receiver_tel") or ""`
  추가.
- 773~792행 `rows.append({...})`에 `"BUYER_TEL": item.get("_buyer_tel", "")` 추가.
- 1519~1546행 큐 아이템 dict 생성부(`item = {...}`)에
  `"buyer_tel": str(row.get("BUYER_TEL") or "")` 추가.
- `/returns/excel2`(엑셀 업로드 경로, 544~584행)로 만들어진 `df2`에는 이 컬럼이
  없으므로 자연히 빈 문자열로 처리됨 (기존 `refund_holder`와 동일하게 안전).

### 3. 이지데스크 전송 — 신규 백엔드 로직 없음

`/return-automation/reply-sms`(`return_automation_routes.py` 549~562행)를 그대로
재사용. 판매자대기 행별 문자 버튼과 SMS 페이지의 "이지데스크로 전송" 버튼 모두
이 엔드포인트를 호출한다.

## 에러 처리 정책

- "일반사유로변경"은 항목별로 독립 처리 — 한 건 실패해도 나머지 계속 진행,
  실패 사유는 `ably_reason_change_error`에 기록.
- 이지데스크 문자 전송 실패(세션 만료 포함)는 해당 전송 시도만 실패로 처리하고
  안내 메시지 표시 — 페이지의 다른 상태에 영향 없음.

## 테스트 계획

- 백엔드: `/returns/ably-change-reason-submit`에 대해 httpx mock으로 3개 PUT
  호출이 순서대로(사유변경 → 환불계좌 재저장 → 확정) 올바른 페이로드로 나가는지
  단위 테스트.
- 수동 검증: 개발 서버에서 실제 판매자대기 건 1개로 "일반사유로변경" 버튼 실행 →
  에이블리 셀러센터에서 사유가 바뀌고 환불이 확정됐는지 확인. 같은 건에서
  "문자" 버튼으로 이지데스크 문자 발송 확인. SMS 페이지에서도 템플릿 적용 후
  "이지데스크로 전송" 버튼으로 실제 수신 확인.
