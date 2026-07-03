# DB 업데이트 관리 — 최신화 확인 결과 영구 저장

## 배경

대시보드(`src/components/Dashboard/Overview.jsx`)의 "DB 업데이트 관리" 카드는 "최신화 확인" 버튼을 눌러야만 원가베이스유(원베) DB가 에이블리 최신 상품 등록 대비 최신 상태인지(파란불) 재수집이 필요한지(빨간불)를 계산해서 보여준다.

현재 문제: 이 결과(`freshnessResult`)는 React 컴포넌트 로컬 state에만 존재한다. 페이지를 새로고침하거나 다른 사용자가 대시보드를 열면 "아직 확인하지 않았습니다"로 초기화되고, 마지막으로 확인한 시각도 알 수 없다.

## 목표

- "최신화 확인" 버튼을 눌러 계산된 결과(상태, 확인 시각 등)를 DB에 저장한다.
- 대시보드를 열면(버튼을 누르지 않아도) 저장된 마지막 결과가 곧바로 표시된다 — 파란불/빨간불이 항상 떠 있는 상태.
- 마지막으로 "최신화 확인"을 실행한 일시를 화면에 표시한다.
- 저장 범위는 회사 전체 공용(사용자별 구분 없음).
- 대시보드 진입 시 에이블리 API를 자동으로 재조회하지는 않는다 — 저장된 값만 불러온다. 실제 재확인은 여전히 버튼 클릭으로만 수행된다.

## 비목표

- 확인 이력(히스토리) 저장 — 최신 1건만 덮어쓰기 저장한다.
- 자동/주기적 재확인(cron 등) — 범위 밖.
- 사용자별 확인 기록 분리 — 범위 밖.

## 설계

### 저장 위치

기존 `backend/api/wonbe_routes.py`의 `wonbe_meta` key-value 테이블(이미 `last_sync_at` 등을 저장 중)에 다음 키를 추가 저장한다. 별도 테이블을 새로 만들지 않고 기존 패턴을 재사용한다.

| key | value 예시 | 의미 |
|---|---|---|
| `freshness_status` | `blue` \| `red` | 마지막 확인 결과 상태 |
| `freshness_checked_at` | `2026-07-03 14:20:00` | 마지막으로 "최신화 확인"을 실행한 시각 |
| `freshness_latest_created_at` | `2026-07-03 13:55:00` | 그 시점에 확인된 에이블리 최신 상품 등록일 |
| `freshness_checked_goods` | `60` | 그 시점에 확인한 상품 수 |
| `freshness_checked_pages` | `2` | 그 시점에 확인한 페이지 수 |

### 백엔드 변경 (`backend/api/wonbe_routes.py`)

1. **`POST /wonbe/freshness-check`** (기존 핸들러 `wonbe_freshness_check`)
   - 기존 계산 로직(에이블리 로그인 → 상품 목록 조회 → `status` 산출)은 변경하지 않는다.
   - 응답을 반환하기 직전에, 계산된 `status`/`latest_created_at`/`checked_goods`/`checked_pages`와 현재 시각(`checked_at`)을 `wonbe_meta`에 `INSERT OR REPLACE`로 저장한다.
   - 응답 JSON에 `checked_at` 필드를 추가로 포함시킨다 (프론트가 버튼 클릭 직후에도 확인 시각을 바로 보여줄 수 있도록).

2. **`GET /wonbe/freshness-status`** (신규)
   - 인증 필요 (`get_current_user`, 기존 엔드포인트들과 동일).
   - `wonbe_meta`에서 위 5개 키를 조회해 그대로 반환. 값이 없으면(한 번도 확인한 적 없으면) `status: null` 등으로 반환.
   - 응답 shape은 `POST /freshness-check`와 동일하게 맞춰서 (`ok`, `status`, `latest_created_at`, `last_sync_at`, `checked_goods`, `checked_pages`, `checked_at`) 프론트에서 동일한 렌더링 코드를 재사용할 수 있게 한다. `last_sync_at`은 기존 로직대로 `wonbe_meta`의 `last_sync_at` 키에서 함께 조회한다.

### 프론트엔드 변경 (`src/components/Dashboard/Overview.jsx`)

1. 컴포넌트 마운트 시(기존 `useEffect(() => { fetchUsers(); ... }, [])`와 별도 혹은 같은 effect에서) `GET /wonbe/freshness-status`를 호출해 결과를 `freshnessResult`에 설정한다. `status`가 없으면 기존과 동일하게 "아직 확인하지 않았습니다" 표시를 유지한다.
2. "최신화 확인" 버튼 클릭 핸들러(`handleFreshnessCheck`)는 기존과 동일하게 `POST /wonbe/freshness-check`를 호출하고 응답을 `freshnessResult`에 반영한다 (응답에 `checked_at`이 추가된 것 외 변경 없음).
3. 화면 텍스트에 기존 "마지막 동기화 {last_sync_at}" 옆에 "마지막 최신화 확인 {checked_at}"을 추가로 표시한다.

### 에러 처리

- GET 조회 실패(네트워크 오류 등) 시에는 조용히 무시하고 기존 "아직 확인하지 않았습니다" 상태를 유지한다 (대시보드 진입을 막지 않음). 별도 에러 메시지를 띄우지 않는다.
- POST 저장 실패(DB 쓰기 오류)는 현재 다른 `wonbe_meta` 저장 로직과 동일하게 예외를 그대로 전파해 500 에러로 응답한다 (별도 처리 없음, 기존 패턴과 일관).

## 테스트 계획

- 백엔드: `wonbe_freshness_check` 호출 후 `wonbe_meta`에 5개 키가 올바르게 저장되는지, `freshness-status` GET이 저장된 값을 그대로 반환하는지 확인하는 간단한 스크립트/수동 curl 테스트.
- 프론트: 브라우저에서 버튼을 눌러 상태 저장 → 새로고침 → 버튼을 누르지 않아도 동일한 파란불/빨간불과 확인 시각이 즉시 보이는지 수동 확인.

## 확장: 입고대기 / 에이블리재고변경 최신업데이트 버튼 추가

### 배경

`입고대기`, `에이블리재고변경` 두 테이블은 이미 `wonbe`(원가베이스유) 테이블 기준으로 신규 코드를 채워 넣는 "최신업데이트" 기능이 있다 — `POST /wonbe/ingodaegi/sync-from-wonbe`, `POST /wonbe/ably-stock/sync-from-wonbe`. 다만 현재는 `DB관리 → 입고대기` / `DB관리 → 에이블리재고변경` 탭(각각 `src/components/DBManager/IngodaegiTable.jsx`, `AblyStockTable.jsx`)에서만 버튼으로 노출되어 있고, 대시보드에는 없다.

### 범위

- 백엔드 변경 없음 — 기존 두 엔드포인트를 그대로 재사용한다.
- 대시보드 "DB 업데이트 관리" 카드에 "최신화 확인" 버튼 옆에 버튼 2개를 추가한다:
  - **입고대기 최신업데이트** → `POST /wonbe/ingodaegi/sync-from-wonbe` 호출
  - **에이블리재고변경 최신업데이트** → `POST /wonbe/ably-stock/sync-from-wonbe` 호출
- 두 버튼 모두 `IngodaegiTable.jsx`/`AblyStockTable.jsx`와 동일한 UX 패턴을 따른다: 클릭 → 로딩 상태 표시 → 성공 시 "최신업데이트 완료: 원가베이스유 기준 신규 N건 추가" 형태의 메시지를 카드 내 상태 영역에 표시, 실패 시 에러 메시지 표시. **DB에 상태를 영구 저장하지 않는다** (원가베이스유 최신화 확인과 달리 파란불/빨간불 개념이 없고, 기존 DB관리 탭 버튼과 동일하게 매번 눌러서 즉시 실행하는 액션이므로).
- 메시지 표시 위치: 기존 `freshnessCard` 영역 재사용 대신, 버튼 3개를 한 행에 배치하고 결과 메시지는 각 버튼 동작에 따라 카드 하단의 공용 상태 텍스트(또는 버튼별 개별 소메시지)로 표시한다 — 구현 시 기존 `freshnessCard`의 레이아웃(`freshnessInfo` / 버튼)을 버튼 3개로 확장하는 형태로 처리.

### 비목표

- 입고대기/에이블리재고변경에 대한 파란불/빨간불 상태 저장 — 범위 밖 (단순 액션 버튼 유지).
