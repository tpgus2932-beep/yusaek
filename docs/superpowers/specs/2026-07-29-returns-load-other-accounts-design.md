# 반품 "불러오기" 모달에 계정 탭 추가 (다른 계정 데이터도 불러오기)

## 배경

`docs/superpowers/specs/2026-07-29-returns-recent-3-snapshots-design.md`에서 만든
"불러오기" 모달은 항상 현재 로그인한 사용자 본인의 최근 3개 스냅샷만 보여준다.
반품 큐 자체는 이미 전 계정이 공유하는 데이터라, 다른 팀원이 임시저장해둔 것도
필요하면 불러올 수 있어야 한다.

## 목표

- "불러오기" 모달 상단에 계정 탭을 추가한다. 탭에는 **현재 임시저장 기록이
  하나라도 있는 계정만** 나열한다(기록이 없는 계정은 탭 자체를 만들지 않음).
- 탭은 각 계정의 가장 최근 저장 시각 기준 내림차순으로 정렬하고, 기본
  선택 탭은 그 목록의 첫 번째(가장 최근에 누군가 저장한 계정)로 한다.
- 탭을 클릭하면 그 계정의 최근 3개 스냅샷 목록으로 바뀐다. 항목 클릭 시
  즉시 불러오는 기존 동작(확인 버튼 없음)은 그대로 유지한다.
- 다른 계정의 스냅샷을 불러오는 것도 본인 것과 동일하게 제한 없이 허용한다
  (내부 협업 도구이고 큐 데이터 자체가 이미 계정 간 공유되므로 별도 권한
  체크는 두지 않는다).

## 비범위

- 계정 탭에 표시이름(display_name) 표시 — `users` 테이블은 로컬 DB
  (`_get_db`)에 있고 스냅샷 테이블은 공유 DB(`_get_shared_db`)에 있어 라우터
  안에서 조인하려면 새 의존성을 추가해야 한다. 이번엔 범위를 좁혀 계정 탭
  라벨은 username 그대로 쓴다.
- 스냅샷 삭제/이름 붙이기 — 여전히 미지원(기존 스펙과 동일).

## 동작 상세

### 백엔드 (`backend/api/returns_routes.py`)

- 신규 `GET /returns/saves-accounts`: `return_saved_snapshots`를 `username`으로
  그룹화해 계정별 가장 최근 `updated_at`을 구하고, 그 값 기준 내림차순으로
  정렬한 목록을 반환한다 — `{"ok": true, "accounts": [{"username": str,
  "latest_updated_at": str}, ...]}`.
- `GET /returns/saves`에 옵션 쿼리 파라미터 `username`을 추가한다. 주어지면
  그 계정의 최근 3개를, 없으면 기존과 동일하게 현재 로그인한 사용자의
  최근 3개를 반환한다(하위 호환).
- `POST /returns/load`에서 `id`로 조회할 때 걸려있던 `AND username = ?`
  제한을 없앤다 — 이제 유효한 `id`면 어떤 계정이 저장한 스냅샷이든 불러올
  수 있다. `id` 없이 호출하는 기존 경로(현재 사용자 최신 1개)는 그대로
  둔다.

### 프론트엔드 (`src/components/Barcode/ReturnsPage.jsx`)

- 새 상태: `snapshotAccounts`(배열), `snapshotAccountsLoading`,
  `activeSnapshotAccount`(선택된 username).
- `openLoadSnapshotModal`을 확장: 모달을 열면 먼저 `GET
  /returns/saves-accounts`를 호출해 `snapshotAccounts`를 채우고,
  `activeSnapshotAccount`를 그 목록의 첫 번째 계정으로 설정한 뒤(목록이
  비어있으면 스냅샷 목록도 비움), 그 계정 기준으로 `GET
  /returns/saves?username=...`를 호출해 `snapshotList`를 채운다.
- 모달 안에 탭 버튼 행을 추가한다 — `snapshotAccounts`의 각 항목을
  버튼으로 렌더링, 클릭 시 `activeSnapshotAccount`를 바꾸고 그 계정의
  목록을 다시 불러온다(`selectSnapshotAccount(username)` 함수 신설).
- 계정이 하나도 없으면(모든 계정에 임시저장 기록 없음) 탭 없이
  "임시저장된 기록이 없습니다."만 보여준다(기존 문구 그대로 재사용).
- `loadSnapshotById`는 기존과 동일 — 이제 다른 계정의 id를 넘겨도 백엔드가
  허용하므로 프론트 쪽 추가 처리는 필요 없다.

## 테스트 계획

- 백엔드: `backend/tests/test_returns_recent_snapshots.py`에 있는
  `test_load_by_id_from_another_user_is_not_found`는 이번 변경으로 전제가
  바뀌므로 `test_load_by_id_from_another_user_succeeds`로 바꿔 200 및 올바른
  데이터 로드를 검증하도록 고친다. `GET /returns/saves-accounts`가 계정별
  최신순으로 정렬되는지, `GET /returns/saves?username=`이 지정한 계정의
  목록을 반환하는지 새 테스트를 추가한다.
- 프론트엔드: 자동화 테스트 없음(컨벤션) — `npm run lint` + `vite build`로
  검증, 실제 클릭 확인은 사용자에게 요청.
