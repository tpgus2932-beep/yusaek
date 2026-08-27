# DB관리: 날짜 선택 삭제 기능 (원가베이스유 / 입고대기 / 에이블리재고변경)

## 배경

DB관리의 세 테이블(원가베이스유, 입고대기, 에이블리재고변경)은 동기화/최신업데이트로
데이터가 계속 누적되기만 하고, 특정 시점에 들어온 데이터만 골라 되돌릴 방법이 없었다.
잘못된 범위로 동기화했거나 최신업데이트를 잘못 돌린 경우를 대비해, 날짜 기준으로
선택 삭제할 수 있는 기능을 추가한다.

## 1. 원가베이스유 (WonbeTable)

- 기준 컬럼: 기존 `등록일` 컬럼 (에이블리 상품 등록일, 이미 존재).
- UI: 기존 "이지어드민 동기화" 버튼 옆 등록일 시작~종료 날짜 입력창(`syncStartDate`,
  `syncEndDate`)을 그대로 재사용해 `삭제` 버튼을 추가한다.
- 클릭 시 `"{start} ~ {end}" 범위의 등록일 데이터를 삭제합니다` confirm 후 진행.
- 백엔드: `DELETE /wonbe/by-registered-date` (payload `{start, end}`).
  `substr(등록일,1,10) BETWEEN ? AND ?` 조건으로 삭제, `{ok, deleted}` 반환.
  등록일이 빈 행은 대상 제외(자동).

## 2. 입고대기 (IngodaegiTable) / 에이블리재고변경 (AblyStockTable)

두 테이블은 행 단위 날짜 컬럼이 없으므로 신규 컬럼을 추가한다.

- 스키마: `입고대기`, `에이블리재고변경` 각각에 `추가일 TEXT NOT NULL DEFAULT ''` 컬럼을
  `ALTER TABLE ... ADD COLUMN`으로 추가 (마이그레이션 패턴은 `_init_wonbe_table`과 동일).
- 기록 시점 (오늘 날짜 `YYYY-MM-DD`, `datetime.now().strftime("%Y-%m-%d")`):
  - `_sync_ingodaegi_from_wonbe` / `_sync_ably_stock_from_wonbe`: 신규 삽입되는 행에 기록.
  - `ingodaegi_append` (입고대기 수동 붙여넣기 추가): 신규 삽입되는 행에 기록.
  - `ingodaegi_init_from_default` / 원가베이스유 import 등 기존 전체 교체 경로는 대상 아님
    (기존 동작 유지, 추가일은 빈 값으로 남음 → 날짜삭제 대상에서 자동 제외).
- UI: 각 테이블의 "최신업데이트" 버튼 옆에 단일 날짜 입력창 + `삭제` 버튼 추가
  (JanggiTable의 "날짜별 삭제"와 동일한 단일 날짜 패턴).
- 클릭 시 `"{date}" 날짜에 추가된 데이터를 삭제합니다` confirm 후 진행.
- 백엔드:
  - `DELETE /wonbe/ingodaegi/by-date` (payload `{날짜}`) — `추가일 = ?` 조건 삭제.
  - `DELETE /wonbe/ably-stock/by-date` (payload `{날짜}`) — `추가일 = ?` 조건 삭제.
  - 둘 다 `{ok, deleted}` 반환. 기존 `janggi/by-date`, `ichae/by-date`와 동일한 스타일.

## 공통 사항

- 세 삭제 모두 실행 전 `window.confirm`으로 확인.
- 성공 시 `삭제 완료: N건` 메시지 표시 후 목록 새로고침(`offset` 0으로 리셋 후 재조회).
- 인증/에러 처리는 기존 라우트들과 동일한 패턴(`get_current_user` 의존성, `HTTPException`).

## 범위 밖

- 원가베이스유에 새 "동기화 시각" 컬럼을 추가하는 방식은 채택하지 않음(사용자가 등록일
  기준 방식을 선택함).
- 입고대기/에이블리재고변경의 기존 행(마이그레이션 이전 데이터)에 대한 소급 `추가일` 채우기는
  하지 않음.
