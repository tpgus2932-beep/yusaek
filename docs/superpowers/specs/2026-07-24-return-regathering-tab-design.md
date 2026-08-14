# 고객대기 "오회수" 처리 + 영구 저장 오회수 탭

## 배경

고객대기 탭의 반품 건 중 택배기사가 회수(수거)를 실패한 건은 이지어드민에서
회수신청을 다시 등록하고, 고객에게 재안내 문자를 보내야 한다. 지금은 이 과정이
전부 수동(이지어드민 직접 접속 + 문자 수동 발송)이라 반품 페이지 안에서 한 번에
처리하고, 처리된 건을 별도로 계속 추적할 수 있는 곳이 없다.

## 목표

1. 고객대기 탭에 체크박스로 선택한 건들을 일괄 처리하는 **"오회수 (N건 선택)"**
   버튼 추가. 클릭 시 각 건마다: ① 이지어드민 회수신청 재등록(DS05/DS00, 기존
   `EzAdminClient.register_return_pickup`) → ② "반품 오회수"라는 이름의 SMS
   템플릿을 이지데스크로 발송. 둘 다 성공한 건만 고객대기 큐에서 제거하고
   **DB에 영구 저장**한다 (서버 재시작에도 유지, 인메모리 `ReturnState`가 아님).
2. 사이드바 반품 페이지에 새 **"오회수" 탭**을 추가해, DB에 저장된 처리 건
   목록을 보여준다. 각 행에 **"완료처리"** 버튼이 있고, 누르면 그 행만 DB에서
   삭제된다 — 그 외에는 어떤 자동 정리도 없다 (완료처리해야만 사라짐).

## 비범위

- 회수신청/문자 실패 건에 대한 재시도 버튼 — 실패하면 고객대기에 그대로 남고,
  사용자가 다시 체크해서 "오회수" 버튼을 누르면 됨 (같은 흐름 재사용).
- "반품 오회수" 템플릿 편집 UI — 기존 "문자 발송" 사이드메뉴의 템플릿 관리
  화면을 그대로 사용 (이미 만들어져 있다고 확인함).
- 오회수 탭에서의 메모/재시도 등 부가 기능 — 목록 조회 + 완료처리만.
- 이지어드민 회수신청 API(`register_return_pickup`) 자체의 동작 변경 — 기존
  그대로 재사용.

## 백엔드 설계

### 신규 DB 테이블 (`backend/main.py`, `accident_invoices` 초기화 패턴과 동일하게
`_get_shared_db()` 사용 — Turso 설정 시 공유, 로컬은 SQLite)

```python
def _init_return_regathering():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_regathering (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice TEXT NOT NULL,
            order_no TEXT NOT NULL DEFAULT '',
            item_sno TEXT NOT NULL DEFAULT '',
            request_no TEXT NOT NULL DEFAULT '',
            buyer_tel TEXT NOT NULL DEFAULT '',
            goods_name TEXT NOT NULL DEFAULT '',
            option_raw TEXT NOT NULL DEFAULT '',
            requested_by TEXT NOT NULL DEFAULT '',
            requested_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()

_init_return_regathering()
```

### 신규 라우터 `backend/api/return_regathering_routes.py`

`build_return_regathering_router(*, get_current_user, get_return_state, get_shared_db, get_setting)`
형태로 `main.py`에 등록 (`get_return_state`는 기존 `_get_return_state` 그대로 재사용
— 큐에서 항목을 제거하기 위함).

임포트는 `return_automation_routes.py`와 동일한 패턴:
```python
from sdk import config
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired
```

- `GET /return-regathering/list` — `SELECT * FROM return_regathering ORDER BY requested_at DESC`,
  응답 `{"items": [...]}`
- `POST /return-regathering/execute` — 요청 바디 `{"items": [...]}` (고객대기 큐
  아이템 그대로, `id`/`match`/`item_sno`/`request_no`/`buyer_tel`/`goods_name`/
  `option_raw`/`order_no` 필드 사용). 처리:
  1. 이지어드민 세션 없으면 `{"ok": False, "need_session": True}` 즉시 반환
     (기존 `_EZADMIN_SESSION_KEY` 체크 패턴).
  2. `sms_templates`에서 `name = '반품 오회수'`인 행을 조회 (`return_shipping_routes.py`의
     `_send_return_pickup_sms`와 동일한 인라인 쿼리 패턴). 없으면 전체 요청을
     `{"ok": False, "detail": "\"반품 오회수\" 템플릿을 찾을 수 없습니다..."}`로 즉시 중단.
  3. 각 item마다:
     - `invoice = item.get("match")` (에이블리 쪽 송장번호 — `item.get("scan")` 아님)
     - `ez.register_return_pickup(invoice)` 호출. `EzAdminSessionExpired` 발생 시
       해당 건 실패 처리하고 계속 진행 (전체 중단 안 함, 세션 만료는 이미 1번에서
       걸러졌어야 하므로 이 시점 실패는 개별 API 오류로 간주).
     - phone = `item.get("buyer_tel")`에서 숫자만 추출 (`return_shipping_routes.py`의
       digit-clean 패턴). phone 없으면 그 건은 문자 없이 회수신청까지만 하고
       "전화번호 없음"으로 실패 처리 (문자 없이는 오회수 탭에 안 옮김 — 회수신청과
       문자 둘 다 성공해야 이동).
     - `ez.send_sms(phone, config.EZDESK_SMS_SENDER, template_msg)` 호출.
       `EzDeskSessionExpired` 발생 시 그 시점에서 전체 루프를 멈추고 이미 처리된
       건까지의 결과 + `need_ezdesk_session: true` 반환 (이지데스크 세션은 한 번
       끊기면 나머지도 다 실패할 것이므로, 회수신청까지 헛되이 반복하지 않음).
     - 회수신청 + 문자 둘 다 성공 → `return_regathering`에 INSERT, 고객대기 큐
       (`state.queue_customer`, `state.all_items`)에서 해당 id 제거.
     - 실패 → 결과에 에러 사유만 기록하고 큐에는 그대로 둠.
  4. 응답 `{"ok": true, "results": [{"id","ok","error"}...], "queues": {...}}`
     (`return_queue_payload(state)` 그대로 재사용하려면 이 값도 라우터에 주입받아야
     함 — `build_return_regathering_router`에 `return_queue_payload` 파라미터 추가).
- `POST /return-regathering/{id}/complete` — `DELETE FROM return_regathering WHERE id = ?`,
  응답 `{"ok": true}`.

### `main.py` 라우터 등록

```python
app.include_router(build_return_regathering_router(
    get_current_user=_get_current_user,
    get_return_state=_get_return_state,
    get_shared_db=_get_shared_db,
    get_setting=_get_setting,
    return_queue_payload=_return_queue_payload,
))
```

## 프론트엔드 설계 (`ReturnsPage.jsx`)

- 탭 배열(현재 1644~1652행 부근)에 `['regather', '오회수']` 추가.
- 신규 상태: `regatherItems`(배열), `regatherLoading`, `regatherExecuteLoading`.
- `activeTab === 'regather'`가 될 때(및 탭 최초 진입/새로고침 시) `GET
  /return-regathering/list` 호출해 `regatherItems` 채움.
- 고객대기 탭(현재 커스텀 인라인 테이블, `renderTable` 미사용)의 액션 버튼 행에
  기존 "에이블리 환불 요청"/"이지어드민 입고처리"/"김승일보내기"/"바코드 출력"
  버튼들 옆에 **"오회수 (N건 선택)"** 버튼 추가 — `selectedCustomer` 사용.
- `handleRegatherExecute(selectedItems)`: `POST /return-regathering/execute`
  호출 → 응답의 `queues`로 `setQueues(normalizeQueues(...))` (성공한 건은 고객대기
  에서 자동으로 사라짐) → 성공/실패 메시지 표시 → `regatherItems`를 다시
  `GET /return-regathering/list`로 새로고침.
- "오회수" 탭 렌더: 목록 없으면 안내 문구, 있으면 `송장번호/상품명/전화번호/
  신청일시` 컬럼 + 각 행 "완료처리" 버튼(클릭 시 `POST
  /return-regathering/{id}/complete` → 성공하면 로컬 `regatherItems`에서 해당
  행만 제거).

## 에러 처리 정책

- 이지어드민 세션 없음 → 전체 요청을 `need_session`으로 즉시 반환 (기존 패턴).
- 이지데스크 세션 만료 → 그 시점까지 처리된 결과는 유지하고 이후 건은 중단,
  `need_ezdesk_session: true`로 안내.
- 회수신청은 성공했지만 문자만 실패(세션 만료 제외 — 예: 전화번호 없음/기타 오류)한
  건은 오회수 탭으로 옮기지 않고 고객대기에 남긴다 (회수신청은 이미 이지어드민에
  등록됐지만, 재추적 목적상 "문자까지 완료된 건"만 오회수 탭에 넣는 것으로 단순화).

## 테스트 계획

- 백엔드: `/return-regathering/execute`에 대해 respx로 EZAdmin DS05/DS00 +
  EzDesk `function.php` 호출을 모킹해 (a) 성공 시 DB에 INSERT되고 고객대기
  큐에서 제거되는지, (b) 템플릿 없음 시 즉시 중단되는지, (c) 이지데스크 세션
  만료 시 그 시점에서 멈추는지 단위 테스트.
- `/return-regathering/{id}/complete`가 실제로 행을 지우는지 단위 테스트.
- 수동 검증: 개발 서버에서 고객대기 건 1개로 "오회수" 실행 → 이지어드민에
  회수신청이 다시 잡히는지, 고객에게 실제 문자가 가는지, 오회수 탭에 뜨는지,
  "완료처리" 누르면 사라지는지 확인.
