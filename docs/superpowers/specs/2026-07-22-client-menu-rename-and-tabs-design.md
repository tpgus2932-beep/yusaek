# 거래처 메뉴 개편: 사이드바 이름 변경 + 일정/품절취소 탭 분리

## 배경
사이드바의 "거래처 일정" 메뉴를 "거래처"로 이름을 바꾸고, 기존 화면(엑셀 업로드/파싱, EZAdmin 연동 등)은 그 아래 "일정" 탭으로 옮긴다. 추가로 "품절취소"라는 빈 껍데기 탭을 새로 만든다.

## 범위
- 사이드바/설정/관리자 화면의 라벨 텍스트 변경
- `ClientSchedulePage.jsx`를 감싸는 얇은 탭 래퍼 컴포넌트 신설
- "품절취소" 빈 placeholder 페이지 신설
- 내부 식별자(`client-schedule` key), 백엔드 API 경로는 변경하지 않음 (기존 `hiddenTabs` 설정·localStorage·API 호환성 유지)

## 변경 파일

1. **`src/components/Layout/Sidebar.jsx`** — "거래처 일정" 텍스트 → "거래처"
2. **`src/components/Layout/SettingsPage.jsx`** — 메뉴 노출 설정 라벨 딕셔너리의 `"client-schedule": "거래처 일정"` → `"거래처"`
3. **`src/components/Admin/AdminUsers.jsx`** — `CLIENT_SCHEDULE_MENU_TAB` label `"거래처 일정"` → `"거래처"`
4. **`src/components/ClientSchedule/ClientPage.jsx`** (신규) — 상단 탭 바(`일정` / `품절취소`)를 그리는 얇은 래퍼. `CollaborationMenuPage.jsx`의 `TOOL_TABS` 버튼형 탭 패턴을 따름. 로컬 `useState`로 활성 탭 관리(기본값 `schedule`), localStorage 영속화 없음(CollaborationMenuPage와 동일).
5. **`src/components/ClientSchedule/ClientPage.module.css`** (신규) — 탭 바 스타일. `CollaborationMenuPage.module.css`의 `.tabs`/`.tabBtn`/`.tabActive` 스타일을 참고.
6. **`src/components/ClientSchedule/ClientCancelSoldOutPage.jsx`** (신규) — 빈 껍데기. 페이지 컨테이너 + "준비 중입니다" placeholder 텍스트만 포함. 실제 기능은 이번 범위 밖.
7. **`src/components/ClientSchedule/ClientSchedulePage.jsx`** — 헤더 타이틀 `"거래처 일정"` → `"일정"` (탭 안에 들어가므로 상위 타이틀 불필요). 그 외 로직은 전혀 손대지 않음.
8. **`src/App.jsx`** — 292행: `client-schedule` 탭 렌더링 시 `<ClientSchedulePage />` 대신 `<ClientPage />` 렌더링. 조건문의 `'client-schedule'` key 문자열은 그대로 유지.

## 비범위(Out of scope)
- "품절취소" 탭의 실제 기능(데이터 처리, API 연동 등) — 추후 별도 설계
- 백엔드 변경 없음
- 내부 tab key(`client-schedule`) 리네이밍 없음

## 검증
- `npm run lint` 통과
- 개발 서버에서 사이드바에 "거래처"로 표시되는지, 클릭 시 "일정"/"품절취소" 탭이 보이는지, "일정" 탭에서 기존 기능이 그대로 동작하는지, "품절취소" 탭이 빈 화면으로 뜨는지 브라우저로 확인
- 설정 페이지(메뉴 노출/숨김)와 관리자 권한 화면에서도 "거래처"로 라벨이 바뀌었는지 확인
