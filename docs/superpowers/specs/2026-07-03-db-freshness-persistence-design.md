# DB 업데이트 관리 — 최신화 확인 결과 영구 저장 + 통합 버튼

## 배경

대시보드(`src/components/Dashboard/Overview.jsx`)의 "DB 업데이트 관리" 카드는 "최신화 확인" 버튼을 눌러야만 원가베이스유(원베) DB가 에이블리 최신 상품 등록 대비 최신 상태인지(파란불) 재수집이 필요한지(빨간불)를 계산해서 보여준다.

현재 문제 1: 이 결과(`freshnessResult`)는 React 컴포넌트 로컬 state에만 존재한다. 페이지를 새로고침하거나 다른 사용자가 대시보드를 열면 "아직 확인하지 않았습니다"로 초기화되고, 마지막으로 확인한 시각도 알 수 없다.

현재 문제 2: `입고대기`, `에이블리재고변경` 두 테이블도 `wonbe`(원가베이스유) 기준으로 신규 코드를 채워 넣는 "최신업데이트" 기능이 각각 있지만(`POST /wonbe/ingodaegi/sync-from-wonbe`, `POST /wonbe/ably-stock/sync-from-wonbe`), `DB관리` 하위 탭에서만 개별 버튼으로 눌러야 해서 대시보드에서 한번에 확인/실행할 수 없다. 세 가지 모두 "원가베이스유가 기준"이라는 같은 맥락의 작업이므로, 대시보드에서는 버튼 하나로 셋 다 같이 실행한다.

## 목표

- 대시보드 "DB 업데이트 관리" 카드의 "최신화 확인" 버튼 **하나**를 누르면 다음 세 가지가 한 번에 실행된다:
  1. 원가베이스유 최신화 확인 (에이블리 API로 최신 상품 등록일 조회 → blue/red 판정)
  2. 입고대기 최신업데이트 (`sync-from-wonbe`)
  3. 에이블리재고변경 최신업데이트 (`sync-from-wonbe`)
- 이 실행 결과(상태, 확인 시각, 각 테이블 신규 추가 건수 등)를 DB에 저장한다.
- 대시보드를 열면(버튼을 누르지 않아도) 저장된 마지막 결과가 곧바로 표시된다 — 파란불/빨간불과 각 항목 결과가 항상 떠 있는 상태.
- 마지막으로 버튼을 실행한 일시를 화면에 표시한다.
- 저장 범위는 회사 전체 공용(사용자별 구분 없음).
- 대시보드 진입 시 자동 실행하지 않는다 — 저장된 값만 불러오고, 실제 재확인/재실행은 버튼 클릭으로만 수행된다.

## 비목표

- 실행 이력(히스토리) 저장 — 최신 1건만 덮어쓰기 저장한다.
- 자동/주기적 실행(cron 등) — 범위 밖.
- 사용자별 실행 기록 분리 — 범위 밖.
- `DB관리 → 입고대기` / `DB관리 → 에이블리재고변경` 탭에 있는 기존 개별 "최신업데이트" 버튼은 그대로 유지한다 (제거하지 않음, 대시보드와 별개로 계속 사용 가능).

## 설계

### 저장 위치

기존 `backend/api/wonbe_routes.py`의 `wonbe_meta` key-value 테이블(이미 `last_sync_at` 등을 저장 중)에 다음 키를 추가 저장한다. 별도 테이블을 새로 만들지 않고 기존 패턴을 재사용한다.

| key | value 예시 | 의미 |
|---|---|---|
| `freshness_status` | `blue` \| `red` | 원가베이스유 마지막 확인 결과 상태 |
| `freshness_checked_at` | `2026-07-03 14:20:00` | 마지막으로 통합 버튼을 실행한 시각 |
| `freshness_latest_created_at` | `2026-07-03 13:55:00` | 그 시점에 확인된 에이블리 최신 상품 등록일 |
| `freshness_checked_goods` | `60` | 그 시점에 확인한 상품 수 |
| `freshness_checked_pages` | `2` | 그 시점에 확인한 페이지 수 |
| `freshness_ingodaegi_added` | `3` | 그 실행에서 입고대기에 새로 추가된 상품코드 수 |
| `freshness_ablystock_added` | `5` | 그 실행에서 에이블리재고변경에 새로 추가된 옵션번호 수 |

### 백엔드 변경 (`backend/api/wonbe_routes.py`)

1. **공통 로직 추출**: 기존 `ingodaegi_sync_from_wonbe`(369번 줄)와 `ably_stock_sync_from_wonbe`(495번 줄) 핸들러 내부의 SQL 로직을 각각 `_sync_ingodaegi_from_wonbe(conn) -> int`, `_sync_ably_stock_from_wonbe(conn) -> int` 헬퍼 함수로 뽑아낸다. 기존 두 엔드포인트는 이 헬퍼를 호출하도록 바꾸되 동작(요청/응답)은 그대로 유지한다.

2. **`POST /wonbe/freshness-check`** (기존 핸들러 `wonbe_freshness_check`, 통합 버튼이 호출)
   - 기존 계산 로직(에이블리 로그인 → 상품 목록 조회 → `status` 산출)은 변경하지 않는다.
   - 같은 `wonbe` DB 커넥션으로 위 두 헬퍼(`_sync_ingodaegi_from_wonbe`, `_sync_ably_stock_from_wonbe`)를 순서대로 호출해 `ingodaegi_added`, `ablystock_added` 건수를 얻는다.
   - 계산된 `status`/`latest_created_at`/`checked_goods`/`checked_pages`/`ingodaegi_added`/`ablystock_added`와 현재 시각(`checked_at`)을 `wonbe_meta`에 `INSERT OR REPLACE`로 저장한다.
   - 응답 JSON에 `checked_at`, `ingodaegi_added`, `ablystock_added` 필드를 추가로 포함시킨다.
   - 에이블리 API 호출이 실패해도(로그인 실패 등) 기존과 동일하게 예외를 던져 전체 실행이 실패로 처리된다 (부분 성공 없음 — 세 작업을 한 번에 묶어 실행한다는 목표에 맞춰 단순하게 처리).

3. **`GET /wonbe/freshness-status`** (신규)
   - 인증 필요 (`get_current_user`, 기존 엔드포인트들과 동일).
   - `wonbe_meta`에서 위 7개 키를 조회해 그대로 반환. 값이 없으면(한 번도 실행한 적 없으면) `status: null` 등으로 반환.
   - 응답 shape은 `POST /freshness-check`와 동일하게 맞춰서 프론트에서 동일한 렌더링 코드를 재사용할 수 있게 한다. `last_sync_at`은 기존 로직대로 `wonbe_meta`의 `last_sync_at` 키에서 함께 조회한다.

### 프론트엔드 변경 (`src/components/Dashboard/Overview.jsx`)

1. 컴포넌트 마운트 시 `GET /wonbe/freshness-status`를 호출해 결과를 `freshnessResult`에 설정한다. `status`가 없으면 기존과 동일하게 "아직 확인하지 않았습니다" 표시를 유지한다.
2. "최신화 확인" 버튼(기존 버튼 그대로, 추가 버튼 없음) 클릭 핸들러(`handleFreshnessCheck`)는 기존과 동일하게 `POST /wonbe/freshness-check`를 호출하고 응답을 `freshnessResult`에 반영한다.
3. 화면 텍스트에 기존 "마지막 동기화 {last_sync_at}" 옆에 "마지막 최신화 확인 {checked_at}"과 "입고대기 {ingodaegi_added}건 추가 · 에이블리재고변경 {ablystock_added}건 추가"를 함께 표시한다.
4. 버튼/카드 레이아웃 자체는 바꾸지 않는다 (버튼 1개 유지, 정보 텍스트만 확장).

### 에러 처리

- GET 조회 실패(네트워크 오류 등) 시에는 조용히 무시하고 기존 "아직 확인하지 않았습니다" 상태를 유지한다 (대시보드 진입을 막지 않음).
- POST 실행 중 일부 단계(에이블리 API, DB 쓰기)가 실패하면 전체를 예외로 전파해 500 에러로 응답한다 (기존 패턴과 일관, 부분 저장 없음).

## 테스트 계획

- 백엔드: 통합된 `wonbe_freshness_check` 호출 후 `wonbe_meta`에 7개 키가 올바르게 저장되는지, 기존 `/ingodaegi/sync-from-wonbe`·`/ably-stock/sync-from-wonbe` 단독 엔드포인트가 헬퍼 추출 후에도 동일하게 동작하는지, `freshness-status` GET이 저장된 값을 그대로 반환하는지 수동 curl 테스트.
- 프론트: 브라우저에서 버튼을 눌러 상태 저장 → 새로고침 → 버튼을 누르지 않아도 동일한 파란불/빨간불·확인 시각·추가 건수가 즉시 보이는지 수동 확인. `DB관리` 탭의 기존 개별 버튼들도 여전히 정상 동작하는지 확인.
