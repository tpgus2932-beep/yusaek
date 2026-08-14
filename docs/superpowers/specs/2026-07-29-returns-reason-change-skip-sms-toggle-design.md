# 일반사유로변경 모달에 "문자 보내지 않기" 옵션 통합

## 배경

`docs/superpowers/specs/2026-07-24-returns-reason-change-template-sms-design.md`에서
"일반사유로변경" 버튼을 누르면 템플릿 선택 모달이 뜨고, 진행 시 사유변경과 함께
문자를 발송하도록 만들었다. 이와 별도로 문자 없이 사유변경만 하는
"일반사유로변경 (문자없이)" 버튼이 판매자대기 탭에 나란히 존재한다
(`docs/superpowers/specs/2026-07-24-returns-seller-reason-change-and-sms-design.md`에서 도입).

버튼 두 개가 같은 기능(사유변경)의 변형이라 UI가 번잡하고, 사용자가 매번 어떤
버튼을 눌러야 할지 헷갈린다. 문자 발송 여부를 모달 안의 옵션으로 흡수하고
버튼은 하나로 통합한다.

## 목표

- 판매자대기 탭의 버튼을 "일반사유로변경 (N건 선택)" 하나만 남긴다.
  "일반사유로변경 (문자없이, N건)" 버튼은 제거한다.
- 클릭 시 뜨는 기존 템플릿 선택 모달에 "문자 보내지 않기" 체크박스를 추가한다.
  - 체크 해제(기본값): 기존과 동일하게 템플릿 드롭다운 표시, 템플릿 선택
    필수, "진행" 시 사유변경 + 선택 템플릿 문자 발송.
  - 체크: 템플릿 드롭다운/미리보기를 비활성화하고, 템플릿 선택 없이
    "진행"이 가능해지며, 사유변경만 처리하고 문자는 보내지 않는다.
- 두 경로 모두 완료 후 결과 메시지(성공/실패 건수, 문자전송 건수 등)를
  보여주는 기존 동작을 유지한다.

## 비범위

- 템플릿 CRUD, `/sms/templates`, `/return-automation/reply-sms`,
  `/returns/ably-change-reason-submit` 등 기존 백엔드 엔드포인트 변경 없음.
- 판매자대기 탭의 다른 버튼(에이블리 환불 요청, 이지어드민 입고처리 등)에는
  영향 없음.
- 처리이력 로그 액션 키(`reason_change_sms`, `reason_change_no_sms`)는 그대로
  유지 — 문자 발송 여부에 따라 기존과 동일한 키로 기록한다.

## 동작 상세

`src/components/Barcode/ReturnsPage.jsx` 기준.

- 새 상태 `reasonChangeSkipSms` (boolean, 기본 `false`)를 모달 관련 상태들
  옆(약 496번째 줄 부근)에 추가한다. `openReasonChangeTemplateModal`과
  `closeReasonChangeTemplateModal`에서 `false`로 초기화/리셋한다.
- 모달 안에서 템플릿 드롭다운 위/아래에 체크박스를 추가:
  `<input type="checkbox" checked={reasonChangeSkipSms} onChange={...}/>` +
  라벨 "문자 보내지 않기".
  - `reasonChangeSkipSms`가 `true`이면 템플릿 드롭다운과 미리보기 영역을
    `disabled`/흐림 처리하거나 렌더링하지 않는다 (템플릿 목록이 비어있는
    경우에도 체크박스는 항상 조작 가능해야 함 — 템플릿이 없어도 문자 없이
    사유변경은 가능해야 하므로).
- "진행" 버튼의 `disabled` 조건과 클릭 핸들러를 분기하는 대신, 기존
  `handleConfirmReasonChangeWithSms`를 확장한 단일 핸들러
  `handleConfirmReasonChange`로 통합한다:
  - `reasonChangeSkipSms`가 `true`이면: 템플릿 관련 검증을 건너뛰고
    `/returns/ably-change-reason-submit`만 호출 → 성공 시
    `logProcessingActions('seller', 'reason_change_no_sms', '일반사유변경(문자없이)', ...)`
    기록 → `일반사유 변경 완료(문자 미발송): X/N건 성공` 메시지 (기존
    `handleReasonChangeWithoutSms`의 메시지 포맷과 동일) → 모달 닫기.
  - `false`이면: 기존 `handleConfirmReasonChangeWithSms` 로직 그대로
    (템플릿 필수 검증 → 사유변경 → SMS 순차 발송 → 세션 만료 처리 →
    합산 메시지).
  - "진행" 버튼의 `disabled`는 `reasonChangeConfirmLoading` 이거나
    (`!reasonChangeSkipSms` 이면서 (`reasonChangeTemplatesLoading` 이거나
    템플릿 미선택)) 인 경우.
- `handleReasonChangeWithoutSms` 함수와 판매자대기 버튼 목록의 "문자없이"
  버튼(및 그 `window.confirm` 확인창)은 삭제한다 — 모달 자체가 확인 단계를
  대신한다.
- 모달 헤더 문구 "일반사유로변경 — 문자 템플릿 선택 (N건)"은 그대로 둔다
  (체크박스로 상태가 이미 드러나므로 별도 분기 문구 불필요).

## 테스트 계획

- 이 프로젝트 프론트 컨벤션상 자동화 테스트 없음 — `npm run lint` 통과
  확인 + 개발 서버에서 판매자대기 탭 수동 확인:
  - 버튼이 "일반사유로변경" 하나만 보이는지.
  - 체크박스 해제 상태에서 기존과 동일하게 템플릿 선택 후 사유변경+문자
    발송이 되는지.
  - 체크박스 선택 시 템플릿 드롭다운이 비활성화되고, 템플릿 없이 "진행"이
    가능하며 문자 없이 사유변경만 되는지.
  - 템플릿이 하나도 없는 상태에서도 체크박스를 켜면 "진행"이 가능한지.
