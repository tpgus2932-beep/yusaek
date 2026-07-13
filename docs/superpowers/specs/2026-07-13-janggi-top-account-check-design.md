# 날짜별장끼정리 TOP비교 — 거래처계좌데이터 미등록 확인/추가 설계

## 배경

`DB관리 > 날짜별장끼정리`의 `TOP비교` 탭(`src/components/DBManager/JanggiTable.jsx`의
`JanggiTopComparison`)은 DB 최근 날짜의 거래처 목록과 TOP90 오늘 완료 매장을 비교해
`✓ 일치` / `⚠ DB만` / `◆ TOP만` 상태를 보여준다.

한편 `거래처계좌데이터` 테이블(A열 = 거래처명, `AccountDataTable.jsx` / 백엔드
`backend/api/wonbe_routes.py`의 `/wonbe/account/*`)은 `이체파일 전환`(`/wonbe/janggi/to-ichae`)
시 `날짜별장끼정리.거래처`와 정확히 일치하는 이름으로만 매칭되어 은행/계좌번호/예금주를
채운다. 매칭 실패 시 이체파일에 `미등록` 상태로 저장된다.

현재는 이 계좌 등록 여부를 `TOP비교` 화면에서 알 수 없고, 계좌가 없는 거래처를 발견해도
별도로 `거래처계좌데이터` 탭으로 이동해 추가해야 한다. 이번 작업은 `TOP비교` 조회 단계에서
바로 계좌 미등록 여부를 보여주고, 그 자리에서 추가할 수 있게 한다.

## 요구사항 (사용자 확정)

- 매칭 기준은 **정확히 일치**(trim 후 문자열 비교). `to-ichae`의 매칭 로직과 동일한 기준으로
  판단해, "등록됨" 표시가 실제 이체파일 전환 결과와 어긋나지 않도록 한다. TOP비교용 별칭
  (`aliasMap`)은 사용하지 않는다 — 별칭은 TOP90 매장명 ↔ DB 거래처명 매핑 목적이라 계좌
  매칭 목적과는 다르다.
- 계좌 미등록 거래처에 "계좌 추가" 시 입력 폼은 **핵심 3항목**(은행 / 계좌번호 / 예금주)만
  받는다. 연락처(E) / 메모(F)는 비워두고, 필요하면 `거래처계좌데이터` 탭에서 추후 채운다.
- UI는 **행 내 인라인 확장** 방식. 별도 모달을 띄우지 않고, DB 패널 테이블의 해당 행 아래에
  입력 행을 펼쳐서 보여준다.
- 계좌 열 표시는 `TOP비교`(TOP90 로드) 여부와 무관하게, `조회`(DB 로드) 직후부터 바로
  보여준다.

## 데이터 흐름

- `JanggiTopComparison`에 `accountSet` state(Set&lt;string&gt;, `거래처계좌데이터.A`를 trim한
  값들)를 추가한다.
- `loadDb()` 실행 시(및 컴포넌트 최초 마운트 시) `GET /wonbe/account/rows`를 호출해
  `accountSet`을 채운다. 계좌 추가 폼 저장 성공 시에는 API를 다시 호출하지 않고 로컬에서
  `accountSet`에 해당 거래처명을 바로 추가한다 (배지 즉시 갱신).
- 계좌 등록 여부 판단 함수: `hasAccount(dbName) = accountSet.has(dbName.trim())`.
- 계좌 추가는 기존 `POST /wonbe/account/row` 엔드포인트를 그대로 사용한다. 이 엔드포인트는
  이미 `payload`의 `A~F` 값을 그대로 저장하므로 **백엔드 변경이 필요 없다**:
  ```js
  POST /wonbe/account/row
  body: { A: dbRow.거래처, B: bank, C: accountNumber, D: owner }
  ```

## UI 변경 (`JanggiTopComparison`, DB 패널 테이블)

- 테이블 헤더에 `확인` 열 다음, `TOP 비교` 열 이전에 `계좌` 열을 추가한다.
  (헤더 순서: 거래처 | 합산금액 | 확인 | 계좌 | [TOP 비교])
- 각 행:
  - `hasAccount(r.거래처)`가 true → `✓ 등록됨` 텍스트.
  - false → `⚠ 미등록` + `계좌추가` 버튼. 버튼 클릭 시 해당 거래처명을
    `addingAccountFor` state에 설정해 인라인 확장 행을 연다 (한 번에 하나만 열림).
- 인라인 확장 행: 테이블 행 바로 아래에 `colSpan` full-width `<tr>`로 삽입, 입력칸 3개
  (은행 / 계좌번호 / 예금주) + `저장` / `취소` 버튼.
  - `저장` 버튼은 세 항목이 모두 비어있지 않을 때만 활성화한다 (빈 계좌 데이터 등록 방지).
  - 저장 성공 시: `accountSet`에 거래처명 추가, `addingAccountFor`를 `null`로 되돌려 확장
    행을 닫고, `message`에 `"계좌 등록 완료: {거래처명}"` 표시.
  - 실패 시: 기존 패턴과 동일하게 `message`에 에러 표시, 확장 행은 열린 채로 유지.
  - `취소`: `addingAccountFor`를 `null`로 되돌린다 (입력값 저장하지 않음).
- 툴바 요약(`topStyles.summary`) 배지에 `계좌 미등록 N건` 배지를 추가한다
  (`dbLoaded && accountLoaded`일 때만 표시, 기존 `badgeOrange` 스타일 재사용).
  `N = sortedDbRows.filter(r => !hasAccount(r.거래처)).length`.

## 에러 / 엣지 케이스

- `거래처계좌데이터`에 동일 거래처명이 여러 건 있어도 `to-ichae`와 동일하게 "존재 여부"만
  판단하므로 중복은 문제되지 않는다 (중복 정리는 이번 범위 밖).
- 계좌 추가 API 실패(네트워크 오류 등) → 기존 컴포넌트들과 동일하게 `message`에 에러 텍스트
  표시, 인라인 폼은 닫지 않아 재시도 가능하게 한다.
- 계좌 미등록 거래처가 0건이면 배지 자체를 표시하지 않는다 (기존 `dbOnlyCount > 0` 조건부
  배지 패턴과 동일).

## 범위 밖 (Out of scope)

- `거래처계좌데이터` 탭(`AccountDataTable.jsx`) 자체의 변경 없음.
- 연락처(E) / 메모(F) 입력은 이번 인라인 추가 폼에 포함하지 않음.
- 계좌 중복 항목 정리/병합 기능은 포함하지 않음.
- `이체파일 전환`(`to-ichae`) 매칭 로직 자체의 변경 없음 (조회 화면에서 미리 보여주는
  기능만 추가).
