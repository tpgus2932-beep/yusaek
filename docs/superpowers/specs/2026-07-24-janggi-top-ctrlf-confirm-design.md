# 날짜별장끼정리 TOP비교 탭 - Ctrl+F 검색 & 스페이스 확인완료

## 배경

`DB관리 > 날짜별장끼정리 > TOP비교` 탭의 DB 패널(`JanggiTopComparison` 컴포넌트, `src/components/DBManager/JanggiTable.jsx`)은 거래처별로 "확인완료" 버튼을 클릭해 체크 표시를 토글한다. 거래처 수가 많을 때 원하는 거래처를 찾아 마우스로 버튼을 클릭하는 게 번거롭다.

브라우저 기본 `Ctrl+F` 찾기는 JS에서 매칭된 요소를 감지할 방법이 없으므로, `Ctrl+F`를 가로채 자체 검색창을 띄우고 키보드만으로 검색 → 확인완료 토글까지 끝낼 수 있게 한다.

## 범위

- 대상: `JanggiTopComparison` 컴포넌트의 DB 패널 테이블(`sortedDbRows`)만. TOP 패널(TOP90 목록)이나 `JanggiListView`(목록 탭)는 대상 아님.
- 기존 "확인완료" 버튼/`toggleCheck` 로직은 그대로 유지하고, 검색 기반 토글은 동일 함수를 재사용한다.

## 활성화 조건

- `dbLoaded === true`일 때만 `window`에 `keydown` 리스너를 등록한다 (`useEffect` 의존성: `dbLoaded`).
- 리스너에서 `(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f"`를 감지하면 `e.preventDefault()`로 브라우저 기본 찾기를 막고 검색 UI를 연다(`searchOpen = true`).
- `dbLoaded`가 `false`가 되면(재조회 등) 검색 상태를 초기화하고 닫는다.

## 검색 UI

- DB 패널 상단에 작은 오버레이 형태의 검색 바를 추가한다: 인풋 + 매칭 카운터(`n/N`) + 닫기(X) 버튼.
- `searchOpen`이 `true`가 되는 순간 인풋에 자동 포커스.
- 검색어는 `searchTerm` state로 관리. 매칭 리스트는 파생 값(`useMemo`)으로 계산:
  - 대상: `sortedDbRows` (현재 정렬 순서 유지)
  - 조건: `거래처`에서 공백 제거 후 대소문자 무시하고 `searchTerm`(공백 제거, 대소문자 무시)을 포함하는 행
  - `searchTerm`이 빈 문자열이면 매칭 리스트도 빈 배열 (선택 없음)
- 매칭 리스트가 갱신될 때마다(검색어 변경 시) `selectedMatchIndex`를 `0`으로 리셋한다.
- 현재 선택된 행 = `matches[selectedMatchIndex]` (있으면). 해당 `<tr>`에 `ref`를 걸어 선택될 때 `scrollIntoView({ block: "nearest" })` 호출.

## 하이라이트 스타일

- 검색으로 선택된 행에는 기존 `rowChecked`/`rowMatch`/`rowDbOnly`와 구분되는 새 CSS 클래스(예: `rowSearchSelected`, 노란 계열 테두리+배경)를 추가로 적용한다. `className`은 기존 로직으로 계산한 `rowClass`에 조건부로 이어붙인다 (다른 상태 스타일과 병행 표시 가능해야 함, 즉 대체가 아니라 추가 강조).
- CSS는 `JanggiTop.module.css`에 추가.

## 키 동작 (검색 인풋에 포커스가 있는 동안, `handleSearchKeyDown`)

- **일반 문자/백스페이스 등**: 브라우저 기본 동작(인풋 입력) 그대로 둔다.
- **Space**: `e.preventDefault()` 하고, 현재 선택된 매칭 행이 있으면 `toggleCheck(선택된 거래처)` 호출. 검색창은 닫지 않고 포커스도 유지 (연속 검색/토글 가능). 매칭이 없으면(선택 없음) 아무 동작 안 함.
- **Enter** (Shift 없음): 매칭 리스트 내에서 다음 인덱스로 이동 (`(selectedMatchIndex + 1) % matches.length`), 순환.
- **Shift+Enter**: 이전 인덱스로 이동 (역순환).
- **Escape**: `searchOpen = false`, `searchTerm = ""`, 선택 상태 초기화. 포커스는 인풋을 벗어남(자연스럽게, blur).

## 엣지 케이스

- 매칭 0건: 카운터에 `0/0` 표시, 선택된 행 없음, Space는 아무 동작 없음.
- `dbLoaded`가 `false`인 상태(TOP비교 탭 진입 직후 아직 조회 전)에서는 `Ctrl+F` 리스너 자체가 없으므로 브라우저 기본 찾기가 동작한다 (이 시점엔 DB 패널이 렌더링되지 않으므로 자연스러움).
- 거래처명에 실제 공백이 포함된 경우: 검색 매칭은 공백 무시라 문제 없음. 다만 검색어 자체에 공백을 입력할 수 없게 되는 트레이드오프가 있으나, 거래처명에 공백을 넣어 검색할 일이 거의 없고 요구사항상 허용된 트레이드오프다.

## 변경 파일

- `src/components/DBManager/JanggiTable.jsx` — `JanggiTopComparison` 컴포넌트에 검색 state/이펙트/UI/키 핸들러 추가.
- `src/components/DBManager/JanggiTop.module.css` — 검색 바 스타일, `rowSearchSelected` 스타일 추가.
