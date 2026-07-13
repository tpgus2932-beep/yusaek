# 거래처 일정 — EZAdmin 날짜(C620) 내보내기 설계

## 배경

`거래처 일정` 페이지(`src/components/ClientSchedule/ClientSchedulePage.jsx`)는 EZAdmin의
IO30 검색 결과를 "기준 파일"로 불러와 가공한 뒤, Sheet2 테이블(A~I 열)에서 거래처별 입고
일정(D열)을 관리자가 수동으로 입력/편집하는 화면이다.

이 화면에는 EZAdmin의 진짜 상품코드(`product_id`)가 I열(엑셀 상 9번째 열, `row[8]`)로
내려오지만, 프론트 파싱 단계(`preprocessBaseSheet`)에서 `srcI`라는 임시 필드로만 잠깐
유지되고 입고파일 매칭(행 삭제) 용도로 한 번 쓰인 뒤 버려진다. `client_schedule_db`
DB 테이블과 저장/조회 API(`GET/PUT /client-schedule/db`)도 A~I 9개 필드만 다루기 때문에,
새로고침하거나 DB에서 다시 불러오면 상품코드 정보 자체가 사라진다.

이번 작업의 목적은 두 가지다.

1. 이 진짜 상품코드가 더 이상 유실되지 않도록 DB에 영구 저장한다.
2. 관리자가 Sheet2에서 입력한 "일정(D열)"을, 상품코드 기준으로 EZAdmin의 `C620` 템플릿에
   업로드해 EZAdmin 쪽 "상품메모"로 반영하는 내보내기 버튼을 추가한다. 참고 스크립트는
   사용자가 제공한 `hywe.py`(리포지토리 루트)이며, 동일한 요청 방식(단일 POST, HTML 응답에서
   정규식으로 결과 파싱)을 그대로 따른다.

## 요구사항 (사용자 확정)

- 상품코드는 **DB에 영구 저장**한다 (세션/화면 상태에만 두지 않음). 새로고침·재접속 후에도
  남아있어야 언제든 내보내기가 가능하다.
- XLS 내보내기 파일의 B열(상품메모) 값은 **D열(일정) 값 하나만** 사용한다. E열(보조 일정)은
  합치지 않는다.
- 일정(D열)은 있지만 상품코드가 없는 행(과거 데이터 등)이 하나라도 있으면 **내보내기 자체를
  차단**하고, 몇 건이 문제인지 사용자에게 알려준다. 부분 내보내기는 하지 않는다.
- EZAdmin 세션(PHPSESSID) 만료 판단은 **저장된 세션 문자열이 없을 때만** `need_session`으로
  처리한다. C620 업로드 응답은 HTML이라 성공 문구 정규식이 매치되지 않으면 (세션 만료 여부와
  무관하게) 일반 실패로 표시한다.
- 새 버튼("EZAdmin 날짜 내보내기")은 상단의 기존 "기준 파일 EZAdmin 불러오기" /
  "입고 파일 EZAdmin 불러오기" 버튼과 같은 영역에 둔다.
- EZAdmin에 실제 값이 반영되는 동작이므로, 실행 전 몇 건이 반영되는지 보여주는
  확인창(`confirm`)을 거친다.

## 데이터 모델 변경 (`backend/main.py`)

기존 `_ensure_client_schedule_column` 마이그레이션 패턴을 그대로 재사용해 컬럼을 추가한다.

```python
_ensure_client_schedule_column(
    "product_code",
    "ALTER TABLE client_schedule_db ADD COLUMN product_code TEXT NOT NULL DEFAULT ''",
)
```

기존 행은 빈 문자열로 채워지며, 상품코드가 없는 구(舊)데이터는 내보내기 시 자동으로
차단 대상에 포함된다(위 요구사항 참고).

## 프론트엔드 변경 (`src/components/ClientSchedule/ClientSchedulePage.jsx`)

- `preprocessBaseSheet`: 필드명 `srcI` → `productCode`로 변경 (값 위치는 그대로 `row[8]`).
- `handleBaseProcess`의 입고파일 매칭 필터(`row.srcI` 참조)도 `row.productCode`로 함께 변경.
- `mergeScheduleRows`, `buildSheet1AndSheet2`는 이미 `{...row}` 스프레드 방식이라
  `productCode` 필드가 자동으로 유지된다 (별도 수정 불필요).
- `autoSaveToDb`의 payload 구성에 `productCode` 포함:
  ```js
  const payload = rowsToSave.map(
    ({ A, B, C, D, E, F, G, H, I, productCode }) => ({ A, B, C, D, E, F, G, H, I, productCode })
  );
  ```
- DB 로드 시(`GET /client-schedule/db` 응답 매핑) `productCode` 필드를 그대로 state에 반영.

### 새 버튼 & 내보내기 흐름

상단 EZAdmin 버튼 영역에 "EZAdmin 날짜 내보내기" 버튼을 추가하고,
`handleExportScheduleToEzadmin` 핸들러를 연결한다.

1. `sheet2Rows` 중 **D열(일정)이 비어있지 않은 행**만 필터링.
2. 그중 `productCode`가 없는 행이 있으면 몇 건인지 세어 즉시 중단:
   `"N건은 상품코드가 없어 내보낼 수 없습니다. 기준 파일을 다시 불러와 가공해주세요."`
3. 내보낼 행이 0건이면 API 호출 없이 `"내보낼 일정이 없습니다"` 표시.
4. 문제 없으면 `confirm("N건을 EZAdmin에 반영합니다. 계속할까요?")` → 취소 시 중단.
5. `POST {LOCAL_API_BASE}/barcode/client-schedule/export-to-ezadmin`
   - body: `{ rows: [{ productCode, note: <D값> }, ...] }`
   - **주의**: `API`(COLLAB_API_BASE)가 아니라 `LOCAL_API_BASE`를 사용한다. 같은 화면의
     `handleBaseFromEzadmin`/`handleIncomingFromEzadmin`이 이미 `LOCAL_API_BASE`로
     `barcode_routes.py`를 호출하고 있고, EZAdmin 세션(PHPSESSID) 저장/조회도 그 서버
     프로세스의 `get_setting`을 통해 이뤄지므로 동일한 서버로 맞춘다.
6. 응답이 `need_session`이면 `openEzadminModal(handleExportScheduleToEzadmin)` 호출 (기존
   패턴과 동일하게, 로그인 성공 후 동일 함수 재실행).
7. 성공/실패를 `status`에 표시. 성공 예: `"EZAdmin 날짜 내보내기 완료 (12건 변경)"`.

## 백엔드 변경 1: DB 스키마/저장·조회 (`backend/api/collab_routes.py`)

### GET/PUT `/client-schedule/db` 수정

- `GET`: `SELECT` 절에 `product_code` 추가, 응답 아이템에 `"productCode": r["product_code"]` 추가.
- `PUT`: `INSERT` 컬럼에 `product_code` 추가, `payload.get("productCode", "")` 값 저장.

이 두 엔드포인트는 지금처럼 `COLLAB_API_BASE`(`API`)로 계속 호출된다 (일정 데이터 자체는
공용/협업 데이터이므로 기존과 동일).

## 백엔드 변경 2: EZAdmin 내보내기 (`backend/api/barcode_routes.py`)

새 엔드포인트는 `client_schedule_db`를 직접 조회하지 않는다 — 프론트가 이미 필터링한
행 데이터(`productCode`, `note`)를 요청 바디로 그대로 받는다. 따라서 `get_db`가 전혀
필요 없고, 이 파일에 이미 있는 `get_setting`, `xlwt`, `httpx`, `_EZADMIN_BASE`,
`_EZADMIN_SESSION_KEY`만으로 구현 가능하다 (`base_file_from_ezadmin` 바로 아래에 추가).

핸들러 로직:

1. `get_setting(_EZADMIN_SESSION_KEY)`가 비어있으면 `{"ok": False, "need_session": True}` 반환.
2. `payload["rows"]`(`[{productCode, note}, ...]`)를 받아 `xlwt`로 엑셀 생성:
   - 헤더 행: A1 = `"상품코드"`, B1 = `"상품메모"`
   - 이후 각 행: A = `productCode`, B = `note`
3. `hywe.py`와 동일한 단일 POST 요청 (httpx.AsyncClient, 기존 라우트들과 동일하게
   `verify=False, follow_redirects=True`):
   ```python
   data = {"page": "1", "action": "update2", "template": "C620", "total": "0", "status": "6"}
   files = {"_file": (filename, xls_bytes, "application/vnd.ms-excel")}
   cookies = {"PHPSESSID": phpsessid}
   ```
4. 응답 HTML에서 `hywe.py`와 동일한 정규식으로 파싱:
   ```python
   re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)
   ```
   - 매치되면 `{"ok": True, "count": int(m.group(1))}`
   - 매치 실패하면 `{"ok": False, "error": "응답에서 변경 완료 문구를 찾지 못했습니다", "raw_snippet": html[:300]}`
     (세션 만료로 재판단하지 않음 — 세션 유무는 1단계에서만 판단).
5. 네트워크/요청 예외는 기존 패턴과 동일하게 `{"ok": False, "error": f"{type(exc).__name__}: {exc}"}`.

## 에러 / 엣지 케이스

- 상품코드 없는 행 존재 → 내보내기 전체 차단 (부분 진행 없음).
- 내보낼 행 0건 → API 호출 없이 안내만 표시.
- EZAdmin 세션 없음 → `need_session` → 로그인 모달 → 성공 시 재시도.
- EZAdmin 응답에서 성공 문구 파싱 실패 → 일반 에러로 표시 (세션 재로그인 유도하지 않음).
- 네트워크 예외 → 에러 메시지 표시.

## 범위 밖 (Out of scope)

- 기존 "기준 파일 EZAdmin 불러오기" / "입고 파일 EZAdmin 불러오기" 흐름 변경 없음.
- `misong_routes.py`의 I200 입고대기설정(3단계 업로드) 로직과는 무관 — 이번 기능은 C620
  단일 업로드 흐름만 사용.
- E열(보조 일정)을 상품메모에 포함하는 것은 이번 범위에 포함하지 않음.
