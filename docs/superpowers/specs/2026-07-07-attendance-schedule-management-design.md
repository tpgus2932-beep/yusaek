# 출퇴근 관리 — 스케줄관리(근무표) 탭 설계

## 배경

참고용으로 전달받은 `yusaek-schedule-app`(`문서\카카오톡 받은 파일\yusaek-schedule-app`, React+TS+Vite)은
"유색 근무표" 라는 이름의 알바 직원 주간 근무 스케줄 관리 프로토타입이다. 백엔드가 없고
전부 `localStorage`에만 저장되는 순수 클라이언트 앱이다.

이번 작업은 이 앱의 기능을 실제 서비스인 `src/components/Attendance/AttendanceAdminPage.jsx`
(PIN 인증 기반 출퇴근 관리 화면, 현재 `직원 관리`/`출퇴근 기록`/`급여명세서` 3개 탭)에
4번째 탭 `📅 스케줄관리` 로 이식하는 것이다.

## 요구사항 (사용자 확정)

- 직원 목록은 참고 앱의 자체 목록을 쓰지 않고, 기존 `attendance_members` 테이블을 그대로 재사용한다.
- 스케줄 데이터는 `localStorage`가 아니라 서버 DB에 저장한다 (다른 관리자/PC에서도 동일하게 보여야 함).
- `date-fns`는 프론트에 설치 완료됨 — 이 기능 안에서만 사용.
- 기존 시스템과 연동할 부분은 연동하고, 참고 앱 대비 개선할 부분은 개선해도 된다.
- 참고 앱의 하드코딩된 11명 기본 직원/기본 스케줄 시드 데이터는 가져오지 않는다. 실제
  `attendance_members`에 이미 등록된 직원을 대상으로, 스케줄은 빈 상태에서 관리자가
  직접 채운다.
- 참고 앱 안에 있던 자체 "직원 관리"(직원 추가/이름수정/삭제) UI는 스케줄 탭에 넣지 않는다 —
  이미 `AttendanceAdminPage`의 `직원 관리` 탭이 그 역할을 하므로 중복 제거.

## 데이터 모델 (백엔드, `backend/api/attendance_routes.py`에 추가)

기존 `_init()` 안에 테이블 3개를 추가한다 (기존 `attendance_members`/`attendance_records`와
같은 파일, 같은 `get_db()` 커넥션 패턴).

```sql
CREATE TABLE IF NOT EXISTS attendance_schedule_fixed_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id      INTEGER NOT NULL,
    weekday        INTEGER NOT NULL,   -- 1~5 (월~금)
    start_time     TEXT NOT NULL,
    end_time       TEXT NOT NULL,
    effective_from TEXT NOT NULL,      -- YYYY-MM-DD
    status         TEXT NOT NULL,      -- 'scheduled' | 'none'
    created_at     TEXT NOT NULL
)

CREATE TABLE IF NOT EXISTS attendance_schedule_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL,
    date       TEXT NOT NULL,
    weekday    INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    status     TEXT NOT NULL,          -- 'scheduled' | 'dayOff' | 'none'
    created_at TEXT NOT NULL,
    UNIQUE(member_id, date)
)

CREATE TABLE IF NOT EXISTS attendance_schedule_memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL,
    date       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(member_id, date)
)

CREATE INDEX IF NOT EXISTS idx_sched_fixed_member ON attendance_schedule_fixed_rules(member_id);
CREATE INDEX IF NOT EXISTS idx_sched_override_member ON attendance_schedule_overrides(member_id);
CREATE INDEX IF NOT EXISTS idx_sched_memo_member ON attendance_schedule_memos(member_id);
```

`member_id`는 `attendance_members.id`를 가리키지만 SQLite에는 FK 제약을 걸지 않는다(기존
`attendance_records.member_name` 방식과 동일하게 애플리케이션 레벨에서만 관계를 관리).

**직원 삭제 시 캐스케이드**: 기존 `DELETE /members/{member_id}` 핸들러 끝에 3개 테이블에서
해당 `member_id` 행을 함께 삭제하는 코드를 추가한다.

## 백엔드 API (`backend/api/attendance_routes.py`에 라우트 추가, 별도 파일 생성 안 함)

기존 `_check_pin(pin)` 헬퍼를 그대로 재사용해 모든 스케줄 엔드포인트에 PIN을 요구한다
(스케줄 탭도 `records`/`salary` 탭과 같은 관리자 전용 기능이므로, `members`처럼 PIN 없이
여는 공개 엔드포인트는 아님).

```
GET    /attendance/schedule?pin=
  → { fixed_rules: [...], overrides: [...], memos: [...] }
  날짜 필터 없이 전체 반환 (직원 10명 안팎 규모라 데이터량이 작음. 이후 커지면 필터 추가).

POST   /attendance/schedule/fixed-rules/bulk
  body: { pin, member_id, effective_from, rules: [{weekday, start_time, end_time, status}] }
  → 참고 앱의 "고정날짜/고정시간 변경"과 동일하게, 호출 시마다 월~금 5개 행을 한 번에
    새로 append한다 (기존 규칙을 덮어쓰지 않고 새 effective_from으로 버전 추가).
  → 서버에서 주 15시간 초과 여부를 검증한다 (아래 검증 섹션 참고). 초과 시 400.

POST   /attendance/schedule/overrides
  body: { pin, member_id, weekday, date, start_time, end_time, status }
  → (member_id, date) 기준 upsert. 특정 날짜의 근무시간 변경/휴무 지정에 사용.
  → status='scheduled'일 때만 주 15시간 검증 수행 (dayOff/none은 근무시간에 안 잡히므로 스킵).

DELETE /attendance/schedule/overrides
  body: { pin, member_id, date }
  → 해당 override 삭제 (고정 규칙으로 복원 = 참고 앱의 "날짜 예외 해제").

POST   /attendance/schedule/memos
  body: { pin, member_id, date, content }
  → upsert. content가 빈 문자열이면 삭제(참고 앱 saveMemo와 동일 동작).

DELETE /attendance/schedule/memos
  body: { pin, member_id, date }
  → 명시적 삭제 버튼용.
```

### 주 15시간 검증 (서버 측 추가 — 참고 앱은 클라이언트에서만 검증했음)

참고 앱은 `localStorage` 단일 클라이언트라 프론트 검증만으로 충분했지만, 이제 여러 관리자가
같은 서버 DB에 동시에 쓸 수 있으므로 서버에서도 동일 규칙을 한 번 더 검증한다:

- 대상 주(월~금)의 모든 근무시간(override 우선, 없으면 fixed_rules) 합이 15시간을 넘으면
  요청을 거부하고 400 + 안내 메시지를 반환한다.
- 계산 로직은 참고 앱의 `getHours`/`weeklyHours`와 동일한 방식(HH:MM 문자열 차이의 소수 시간).

## 프론트엔드 변경

### 새 파일 `src/components/Attendance/ScheduleTab.jsx`

`AttendanceAdminPage.jsx`가 이미 994줄이라 안에 다 넣지 않고 별도 컴포넌트로 분리한다.
Props: `pin`(인증된 PIN 문자열), `members`(이미 로드된 `{id, name}[]`).

포팅하는 기능 (참고 앱 `App.tsx` 기준, JS로 변환하며 TS 타입은 제거):

- 주간 그리드 뷰 (월~금 5열 + 직원별 행 + 주간합계 열, 하단에 일별 합계/출근 인원 합계 행)
- 셀 클릭(선택) / 더블클릭(편집 모달 오픈) / Enter 키로도 편집 모달 오픈
- 편집 모달: "근무" 탭(시작/종료 시간 선택 + 이 날짜만 저장/휴무/삭제/예외 해제) + "메모" 탭
- 요일 헤더 우클릭 컨텍스트 메뉴 → "휴무일 지정" (해당 요일 전체 직원 일괄 휴무 override 생성)
- Ctrl+C(복사) / Ctrl+V(붙여넣기) / Delete(삭제) 키보드 단축키 — input/select/textarea에
  포커스가 없을 때만 동작 (참고 앱과 동일 가드)
- 공휴일 자동 휴무 처리 — 참고 앱의 2026~2030 `KOREAN_HOLIDAYS` 하드코딩 배열을 그대로 이식
- "고정날짜 변경" / "고정시간 변경" 매니저 패널 (직원 선택 → 요일 토글/시간 선택 → 저장 시
  `POST .../fixed-rules/bulk` 호출)
- "캘린더 보기" 패널 (월 선택 + 직원 다중 선택 → 월간 달력에 근무/휴무 표시, 출근시간대 표기 토글)
- 상단 "이전 주 / 주차 이동(날짜 선택) / 다음 주" 네비게이션, 복사됨 상태 표시

**빼는 것**: 참고 앱의 `showEmployeeManager` 패널(자체 직원 추가/수정/삭제 UI)은 이식하지
않는다.

### `AttendanceAdminPage.jsx` 변경

- `tabBar`에 4번째 버튼 `📅 스케줄관리` (`tab === 'schedule'`) 추가
- `{tab === 'schedule' && <ScheduleTab pin={pin} members={members} />}` 렌더링
- 기존 `members` state(이미 `loadMembers()`로 로드됨)를 그대로 prop으로 전달 — 별도 fetch 없음

### 데이터 흐름

- `ScheduleTab` 마운트 시 `GET /attendance/schedule?pin=` 한 번 호출 → `fixedRules`,
  `overrides`, `memos` state 세팅
- 모든 쓰기(override/memo/fixed-rule 저장, 휴무 일괄 지정)는 해당 API 호출 후 성공하면
  로컬 state를 낙관적으로 갱신(참고 앱의 setState 패턴 유지) — 실패 시 에러 메시지 표시 후
  변경 없음(재조회하지 않고 이전 state 유지, 다음 수동 새로고침에서 서버 진실로 재동기화)
- `members` prop이 바뀌면(직원 관리 탭에서 추가/삭제) 그리드도 즉시 반영됨 (별도 캐시 없음)

## 에러 처리

- 서버 API 실패(네트워크 오류, 400 검증 실패 등)는 참고 앱의 `alert()` 대신 기존
  `AttendanceAdminPage`/다른 탭들과 동일하게 화면 내 에러 메시지 영역에 표시한다
  (`alert` 사용 지양 — 참고 앱에만 있던 방식이고 나머지 앱 전체는 인라인 메시지 사용).
- 주 15시간 초과 등 서버측 400 응답의 `detail` 메시지를 그대로 보여준다.

## 범위 밖

- 실제 출퇴근 기록(`attendance_records`)과 예정 스케줄을 비교/대조하는 기능 없음 (스케줄
  탭은 독립적인 근무표 관리 도구)
- 스케줄 데이터 엑셀 내보내기/인쇄 없음 (참고 앱에도 없던 기능)
- 주 15시간 기준값을 관리자가 바꿀 수 있는 설정 UI 없음 (상수로 고정 — 참고 앱과 동일)
- 사용자별/역할별 스케줄 조회 권한 분리 없음 (기존 PIN 하나로 전체 관리자 공용, 다른 탭과 동일 정책)
