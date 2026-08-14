# 반품 임시저장 "불러오기"에서 최근 3개 중 선택

## 배경

반품 스캔 페이지(`ReturnsPage.jsx`)의 "임시저장"/"불러오기" 버튼은 사용자당 스냅샷
1개만 덮어쓰기로 저장한다(`return_saved_states` 테이블, `username`이 PK). "불러오기"를
누르면 그 1개만 그대로 불러온다. 작업하다 실수로 최신 임시저장을 덮어써버리면
직전 상태로 되돌아갈 방법이 없어서, 최근 3개까지는 선택해서 불러올 수 있어야 한다.

## 목표

- "임시저장" 버튼을 누를 때마다 기존 것을 덮어쓰지 않고 새 기록으로 쌓이며,
  사용자당 최신 3개만 남기고 더 오래된 기록은 자동 삭제한다.
- "불러오기" 버튼을 누르면 모달이 뜨고, 현재 사용자의 최근 임시저장 최대 3개가
  저장 시각 목록으로 나열된다. 항목을 클릭하면 그 즉시 해당 스냅샷을 불러오고
  모달이 닫힌다(별도 "확인" 버튼 없음).
- 저장된 기록이 하나도 없으면 "임시저장된 기록이 없습니다." 안내만 보여준다.

## 비범위

- 스냅샷에 이름 붙이기, 개별 삭제, 3개보다 많이 보관하기 — 전부 미지원.

## 추가 결정: 기존 데이터 마이그레이션

최초 설계 시점엔 기존 `return_saved_states`(단일 저장) 데이터를 새 테이블로
옮기지 않기로 했으나, 사용자가 기존에 저장해둔 데이터를 잃고 싶지 않다고 해
마이그레이션을 추가했다. `backend/services/returns_utils.py`에
`_migrate_return_saved_states_to_snapshots(conn)`을 추가해 서버 시작 시마다
실행한다: `return_saved_states`의 각 사용자 행을, 그 사용자가
`return_saved_snapshots`에 아직 스냅샷이 하나도 없을 때만 그대로 복사한다
(이미 하나라도 있으면 건너뜀 — 매 재시작마다 실행해도 중복 삽입되지 않는
멱등 처리). 옛 테이블 자체는 삭제하지 않고 그대로 둔다.
- 판매자대기/고객대기 등 큐 데이터 자체의 스키마·payload 포맷 변경 없음 — 저장
  방식(몇 개를 어떻게 저장하는지)만 바뀐다.
- 다른 페이지의 저장/불러오기 기능에는 영향 없음.

## 동작 상세

### 백엔드 (`backend/main.py`, `backend/api/returns_routes.py`)

- `backend/main.py`에 `_init_return_saved_snapshots()`를 추가해 새 테이블을 만든다
  (`_init_return_saved_states()` 호출부 바로 아래에 같은 패턴으로):
  ```sql
  CREATE TABLE IF NOT EXISTS return_saved_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
  )
  ```
  기존 `_init_return_saved_states()`와 `return_saved_states` 테이블은 그대로 둔다
  (비범위 참조).
- `GET /returns/state`: `saved_at` 조회 쿼리를 `return_saved_states` 대신
  `return_saved_snapshots`에서 `WHERE username = ? ORDER BY id DESC LIMIT 1`로 바꾼다.
- `POST /returns/save`: upsert 대신 매번 새 행을 INSERT하고, 같은 트랜잭션에서
  해당 사용자의 최신 3개(`id` 내림차순)를 제외한 나머지 행을 DELETE한다.
- `POST /returns/load`: 요청 바디에 옵션 필드 `id`를 추가로 받는다(`Body(None)`,
  없으면 빈 dict로 취급). `id`가 있으면 `WHERE id = ? AND username = ?`로 정확히
  그 스냅샷을, 없으면 기존과 동일하게 최신 1개(`ORDER BY id DESC LIMIT 1`)를
  불러온다(id 없이 호출하는 다른 경로는 없지만 하위호환으로 남겨둔다). 못 찾으면
  기존과 동일하게 404 + "임시저장된 반품 상태가 없습니다."
- 신규 `GET /returns/saves`: 현재 사용자의 최근 3개를 `{id, updated_at}` 목록으로
  반환한다 — `{"ok": true, "items": [{"id": 3, "updated_at": "..."}, ...]}`
  (최신순, 최대 3개).

### 프론트엔드 (`src/components/Barcode/ReturnsPage.jsx`)

- 새 상태: `loadSnapshotModalOpen`, `snapshotList`(배열), `snapshotListLoading`.
- "불러오기" 버튼의 `onClick`을 `handleLoadSnapshot` 대신 `openLoadSnapshotModal`로
  바꾼다. `openLoadSnapshotModal`은 모달을 열고 `GET /returns/saves`를 호출해
  `snapshotList`를 채운다.
- 모달 안에서 `snapshotList`를 저장 시각 버튼 목록으로 렌더링한다(로딩 중엔
  "목록 불러오는 중...", 빈 배열이면 "임시저장된 기록이 없습니다."). 각 버튼을
  클릭하면 `loadSnapshotById(id)`를 호출한다.
- `loadSnapshotById(id)`는 기존 `handleLoadSnapshot`의 로직(POST `/returns/load`,
  `status`/`queues`/`onebeRows`/`savedAt`/`lastType` 갱신, 완료 메시지)을 그대로
  쓰되 요청 바디에 `{ id }`를 포함하고, 성공하면 모달을 닫는다. 기존
  `handleLoadSnapshot` 함수는 제거한다.
- 저장 시각은 `new Date(item.updated_at).toLocaleString('ko-KR', { month:
  '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })` 형태의 간단한
  포맷 헬퍼로 표시한다(예: "07/29 15:42"). 파싱 실패 시 원본 문자열을 그대로
  보여준다.
- 모달 마크업/스타일은 기존 "일반사유로변경" 템플릿 선택 모달과 동일한
  오버레이/카드 스타일을 재사용한다.

## 테스트 계획

- 백엔드: `backend/tests/`에 새 테스트 파일을 추가해(기존
  `test_return_regathering_routes.py`의 in-memory SQLite + `_NoCloseConn` 패턴을
  재사용) 다음을 검증한다.
  - 저장을 4번 하면 최신 3개만 남고 가장 오래된 것이 삭제되는지.
  - `GET /returns/saves`가 최신순으로 최대 3개를 반환하는지.
  - `POST /returns/load`에 특정 `id`를 주면 그 스냅샷이 로드되는지, 다른 사용자의
    `id`를 주면 404가 나는지.
  - `id` 없이 `POST /returns/load`를 호출하면 최신 스냅샷이 로드되는지(하위호환).
- 프론트엔드: 이 프로젝트 컨벤션상 자동화 테스트 없음 — `npm run lint` +
  `vite build` 통과 확인. 실제 개발 서버 수동 확인은 브라우저 도구가 없어
  스킵하고, 사용자에게 수동 확인을 요청한다.
