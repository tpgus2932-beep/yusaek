# 반품 특이사항 등록 + 스캔 시 알림

## 배경

반품 페이지(`ReturnsPage.jsx`)에서 바코드를 스캔하면 판매자/고객/미매칭으로
자동 분류되지만, 특정 원송장번호(반품 전 원래 배송 송장번호)에 대해 "이 건은
주의해서 처리해야 한다"는 사전 메모를 남길 방법이 없다. CS나 관리자가 미리
알고 있는 특이사항(예: 반복 컴플레인, 파손 이력 등)을 등록해두면, 창고에서
바코드를 스캔하는 사람이 해당 송장이 찍히는 순간 바로 알아챌 수 있어야 한다.

## 목표

1. 반품 페이지의 엑셀 업로드 영역, "초기화" 버튼(`ReturnsPage.jsx:1943`) 옆에
   **"특이사항"** 버튼을 추가한다. 클릭 시 모달이 뜨고, 원송장번호 + 특이사항
   내용을 입력해 등록할 수 있다. 이미 등록된 특이사항 목록도 같은 모달에서
   보고 삭제할 수 있다.
2. 등록된 원송장번호가 반품 바코드 스캔(`/returns/scan`, 판매자/고객 매칭
   경로)으로 들어오면:
   - 해당 스캔으로 큐에 추가되는 항목에 특이사항이 계속 표시된다 (대기
     테이블 행에 배지).
   - 스캔 즉시 알림음이 평소 분류음 대신 `특이사항.wav`로 재생된다.
3. 특이사항은 회사 전체가 공유하는 영구 데이터로 저장한다 (서버 재시작에도
   유지, 다른 사용자 화면에도 동일하게 적용).

## 비범위

- 교환(exchange) 스캔 경로 — 이 경로는 CJ/롯데 송장 → 원송장번호 매핑을
  거치지 않아 "원송장번호" 개념이 없다. 이번 기능은 일반 반품(판매자/고객)
  스캔 경로에만 적용한다.
- 특이사항 수정 UI — 같은 원송장번호로 다시 등록하면 기존 내용을 덮어쓰는
  것으로 "수정"을 대신한다. 별도 수정 버튼은 만들지 않는다.
- 특이사항 이력/감사로그 — 등록자/등록일시만 저장하고 별도 이력 추적은 하지
  않는다.
- 스캔 시 특이사항 내용을 팝업(alert/confirm)으로 띄우는 것 — 사용자가
  "대기 테이블 배지 + 알림음 변경"만 요청했으므로 팝업은 만들지 않는다.

## 백엔드 설계

### 신규 DB 테이블 (`backend/main.py`, `_get_shared_db()` 사용 — 다른 반품
부가기능(`return_regathering`, `return_processing_log`)과 동일하게 공유 DB)

```python
def _init_return_special_notes():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_special_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no TEXT NOT NULL UNIQUE,
            note TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()

_init_return_special_notes()
```

### 신규 라우터 `backend/api/return_special_notes_routes.py`

`return_regathering_routes.py`와 동일한 함수형 DI 패턴:

```python
def build_return_special_notes_router(*, get_current_user, get_db, clean_invoice):
    router = APIRouter(prefix="/return-special-notes")
    ...
    return router
```

- `GET /return-special-notes/list` — `SELECT * FROM return_special_notes ORDER BY created_at DESC`,
  응답 `{"items": [{"id","invoiceNo","note","createdBy","createdAt"}...]}`
  (snake_case DB 컬럼 → camelCase 응답, 기존 `return_anomaly_routes.py`의
  `list_anomalies`와 동일한 변환 스타일).
- `POST /return-special-notes/add` — 바디 `{"invoice_no": str, "note": str}`.
  - `invoice_no = clean_invoice(payload.get("invoice_no"))`, 비어있으면 400.
  - `note`가 비어있으면(strip 후) 400.
  - `INSERT INTO return_special_notes (invoice_no, note, created_by, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(invoice_no) DO UPDATE SET
    note=excluded.note, created_by=excluded.created_by, created_at=excluded.created_at`
    (같은 원송장번호 재등록 시 덮어쓰기).
  - 응답은 `list_special_notes`와 동일하게 갱신된 전체 목록을 돌려준다
    (프론트가 별도로 다시 조회하지 않고 바로 리스트를 갱신할 수 있게).
- `DELETE /return-special-notes/{note_id}` — `DELETE FROM return_special_notes
  WHERE id = ?`, 응답 `{"ok": true}`.

### `main.py` 라우터 등록

`_init_return_regathering()` 등록 블록 근처에 추가:

```python
_init_return_special_notes()

app.include_router(
    build_return_special_notes_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        clean_invoice=_clean_invoice,
    )
)
```

### `/returns/scan` 연동 (`backend/api/returns_routes.py`)

`build_returns_router` 안에 조회 헬퍼 추가 (라우터 정의부 상단,
`_request_memo_for_item` 근처):

```python
def _lookup_special_note(invoice_no: str) -> str:
    invoice_no = clean_invoice(invoice_no)
    if not invoice_no:
        return ""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT note FROM return_special_notes WHERE invoice_no = ?",
            (invoice_no,),
        ).fetchone()
    finally:
        conn.close()
    return row["note"] if row else ""
```

`returns_scan` 핸들러(`returns_routes.py:1561`)의 일반 반품 매칭 경로에서,
`e_val`이 확정된 직후(`returns_routes.py:1652` 부근, `if not e_val:` 분기
다음)에:

```python
special_note = _lookup_special_note(e_val)
```

그리고 `row_indexes`로 item을 만드는 루프(`returns_routes.py:1683~1711`) 안
item dict에 `"special_note": special_note,` 필드를 추가한다. 함수 마지막
`return` 문(`returns_routes.py:1745`)에도 최상위로 `"special_note": special_note`
를 실어서, 프론트가 이번 스캔에서 특이사항이 매칭됐는지 바로 알 수 있게 한다
(`special_note`가 빈 문자열이면 매칭 없음).

미매칭(`e_val` 없음) 분기와 교환 스캔 분기는 건드리지 않는다.

## 프론트엔드 설계 (`ReturnsPage.jsx`)

### 버튼 + 모달

- `compactActions` 버튼 행(`1933~1946`)의 "초기화" 버튼 옆에 "특이사항" 버튼
  추가. 클릭 시 `specialNoteModalOpen`을 `true`로 하고 `GET
  /return-special-notes/list`로 목록을 불러온다.
- 신규 상태: `specialNoteModalOpen`(bool), `specialNoteList`(배열),
  `specialNoteListLoading`, `specialNoteInvoiceInput`, `specialNoteTextInput`,
  `specialNoteSaving`.
- 모달 UI는 기존 `smsComposeItem` 모달(`2861~2913`)과 동일한 인라인 오버레이
  스타일로 구현:
  - 원송장번호 입력창 + 특이사항 textarea + "등록" 버튼(둘 다 비어있으면
    비활성화).
  - 등록 성공 시 입력창 초기화하고 목록 갱신(서버가 돌려준 목록으로 바로
    `setSpecialNoteList`).
  - 등록된 목록을 아래에 나열: 원송장번호 / 특이사항 내용 / 등록자·등록일 /
    "삭제" 버튼. 삭제 클릭 시 `DELETE /return-special-notes/{id}` 호출 후
    로컬 목록에서 제거.

### 스캔 사운드

- `soundsRef.current` 초기화(`256~267`)에 `specialNote: pool('/sounds/특이사항.wav')`
  추가.
- `handleScan`(`1155~1178`)에서 `scanBarcode` 응답에 `data.special_note`가
  있으면(non-empty) `playTypeSound` 대신 `playSound('specialNote')`를 호출한다
  (분류 탭 이동/큐 갱신 로직은 그대로 유지 — 소리만 특이사항 쪽으로 대체).

### 대기 테이블 배지

- `renderTable`(`1653`)에 `hasSpecialNote = items.some((item) => item.special_note)`
  추가하고, 기존 `hasReason`/`hasDetailReason`과 같은 방식으로 조건부 컬럼
  추가:
  - 헤더: `{hasSpecialNote && <th>특이사항</th>}`
  - 셀: `{hasSpecialNote && <td style={{ color: '#dc2626', fontWeight: 600 }}>{item.special_note ? \`⚠ ${item.special_note}\` : ''}</td>}`
- `renderTable`은 전체/판매자/고객/미매칭/교환판매자/교환고객 탭에 공통으로
  쓰이므로, 교환 쪽 큐에는 `special_note` 필드 자체가 없어 해당 탭에는 이
  컬럼이 자동으로 나타나지 않는다.

## 에러 처리 정책

- `invoice_no` 또는 `note`가 비어있는 등록 요청 → 400 응답, 프론트는
  메시지만 표시하고 모달은 유지.
- 존재하지 않는 `id`로 삭제 요청 → DB에 해당 행이 없어도 `DELETE`는 조용히
  0건 삭제로 끝나고 `{"ok": true}` 반환 (별도 404 처리 안 함 — 다른 CRUD
  라우터들의 관례와 동일).
- 스캔 시 특이사항 조회(`_lookup_special_note`)가 실패할 상황은 없음(단순
  SELECT) — 별도 예외 처리 불필요.

## 테스트 계획

- 백엔드 단위 테스트(`backend/tests/test_return_special_notes_routes.py`):
  - `POST /return-special-notes/add` 후 `GET /list`에 반영되는지.
  - 같은 `invoice_no`로 재등록 시 덮어쓰기(개수는 그대로, 내용만 변경)되는지.
  - `DELETE /return-special-notes/{id}` 후 목록에서 사라지는지.
  - `/returns/scan`에 대해 CJ 매핑 스켈레톤 데이터를 셋업하고, 특이사항이
    등록된 원송장번호를 스캔했을 때 응답에 `special_note`가 채워지고 큐
    아이템에도 `special_note`가 붙는지 (기존 `test_returns_buyer_tel.py`류
    스캔 테스트 패턴 재사용).
- 수동 검증: 개발 서버에서 원송장번호 하나로 특이사항 등록 → 해당 송장을
  스캔 → 대기 테이블에 배지 표시 + `특이사항.wav` 재생 확인, 모달에서 삭제
  후 재스캔 시 배지/사운드가 다시 원래대로 돌아오는지 확인.
