# 거래처 일정 — EZAdmin 날짜 내보내기 만료 자동 정리 설계

## 배경

[[2026-07-13-client-schedule-ezadmin-export-design]]에서 구현한 "EZAdmin 날짜 내보내기"
(`POST /barcode/client-schedule/export-to-ezadmin`)는 매번 그 시점의 `sheet2Rows` 중
D열(일정)이 채워진 행만 골라 `{productCode, note: D값}`을 EZAdmin C620 템플릿에 업로드한다.

문제: 이 엔드포인트는 우리 쪽에 아무 이력도 남기지 않는 일회성 프록시다(조사 완료,
`backend/api/barcode_routes.py:3106-3159`). 그래서 다음 두 경우에 EZAdmin의
"상품메모"에 지난 날짜가 영구히 남는다.

1. 사용자가 D열 값을 수정하지 않고 그대로 둔 채, 날짜가 지나도 재내보내기 시 그 지난
   날짜 텍스트가 그대로 다시 전송된다.
2. 사용자가 화면에서 해당 상품의 스케줄 행을 완전히 지우거나 D열을 비운 경우, 그 상품은
   다음 내보내기 요청에 아예 포함되지 않으므로 EZAdmin 쪽 note가 영영 갱신되지 않는다.

이번 작업 목적: 내보낸 상품코드+날짜를 서버에 기록해두고, 다음 내보내기 시점에
"이미 지났는데 아직 빈칸으로 정리되지 않은" 항목을 자동으로 찾아 빈칸으로 함께
전송한다.

## 요구사항 (사용자 확정)

- 이력은 **상품코드 + 날짜(`YYYY-MM-DD`)** 조합으로 유니크하게 관리한다.
- D열 값이 실제 날짜 형식(`YYYY-MM-DD`)이고 그 날짜가 **오늘이거나 이미 지났으면**
  (내보내기 버튼을 누른 시점 기준, KST) 원래 값 대신 **빈칸**을 전송한다. 화면에 아직
  그 값이 남아있어도 예외 없이 빈칸으로 덮는다.
- D열이 `YYYY-MM-DD` 형식이 아닌 텍스트(`이번주중`, `다음주중` 등)는 이번 기능의 대상이
  아니다 — 기존 `normalizeDValueForMerge` 로직이 이미 자체적으로 만료 처리하므로 건드리지
  않는다.
- 같은 상품코드가 이번 내보내기의 "현재 스케줄" 목록에 포함되어 있으면(D열에 값이 있으면),
  그 상품에 대한 과거 이력은 **빈칸을 따로 보내지 않고 그냥 삭제만** 한다 — 현재 값이
  이미 EZAdmin의 note를 덮어쓰므로 중복/충돌 전송을 피한다.
- 이력 레코드에는 "정리 완료" 상태를 플래그로 남기지 않는다. 처리(빈칸 전송 완료 또는
  새 값으로 대체됨)가 끝나면 해당 레코드를 즉시 삭제한다 — 감사 이력은 필요 없고 테이블을
  작게 유지한다.
- 화면 D열이 전부 비어 있어(현재 내보낼 신규 스케줄 0건) 버튼을 눌러도, 정리 대상 이력이
  있다면 **백엔드를 호출해서 정리만 수행**한다. 기존처럼 "내보낼 일정이 없습니다"로
  API 호출 자체를 막지 않는다.
- 내보내기 완료 메시지는 기존과 동일하게 **총 변경 건수만** 표시한다(자동 정리분을
  별도로 구분해서 보여주지 않음).

## 데이터 모델 (`backend/main.py`)

`_init_client_schedule_db()` 바로 아래에 초기화 함수를 추가한다 (기존
`client_schedule_db` 초기화와 동일한 패턴).

```python
def _init_client_schedule_export_log():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS client_schedule_export_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            note_date TEXT NOT NULL,
            exported_at TEXT NOT NULL,
            UNIQUE(product_code, note_date)
        )
        """
    )
    conn.commit()
    conn.close()


_init_client_schedule_export_log()
```

- `client_schedule_db`(협업/공유 데이터)와 같은 성격이므로 `_get_shared_db()`를 사용한다.
- `note_date`는 항상 `YYYY-MM-DD`만 저장한다(비-날짜 텍스트는 애초에 이 테이블에 들어오지
  않음).
- **불변식**: 이 테이블에는 항상 `product_code`당 최대 1행만 존재한다. 아래 9단계에서
  새 미래 날짜를 기록할 때 항상 "해당 product_code의 기존 행을 전부 삭제 후 삽입"하기
  때문에, 같은 상품코드가 서로 다른 날짜로 동시에 여러 행을 갖는 경우는 발생하지 않는다.

### `build_barcode_router`에 shared DB 주입

`barcode_routes.py`는 현재 shared DB에 접근할 방법이 없다(`get_setting`/`set_setting`만
주입되어 있고 이는 로컬 DB의 `app_settings` 테이블용). `build_barcode_router(...)`
시그니처(`barcode_routes.py:34`)에 `get_shared_db` 파라미터를 추가하고,
`main.py:1369` 호출부에 `get_shared_db=_get_shared_db`를 추가한다.

## 백엔드 변경 (`backend/api/barcode_routes.py`)

`client_schedule_export_to_ezadmin` 핸들러(`3106-3159`)를 아래 로직으로 교체한다.
요청 바디 형식(`{ rows: [{productCode, note}] }`)은 그대로 유지한다 — 판정/이력 로직만
백엔드로 옮긴다.

```python
from zoneinfo import ZoneInfo
KST = ZoneInfo("Asia/Seoul")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
```

1. `phpsessid` 체크는 기존과 동일 (세션 없으면 `need_session`).
2. `today = datetime.now(KST).date()`
3. `rows = payload.get("rows") or []` — 각 행에 대해 `output_note` 계산:
   - `note`가 `_DATE_RE`에 매치하고 `date.fromisoformat(note) <= today` → `output_note = ""`
   - 그 외 → `output_note = note` (원본 유지, 미래 날짜/비-날짜 텍스트 포함)
4. `current_codes = {row["productCode"] for row in rows}`
5. shared DB에서 정리 대상 조회:
   ```sql
   SELECT DISTINCT product_code FROM client_schedule_export_log
   WHERE note_date <= :today
   ```
   조회 결과 중 `product_code not in current_codes`인 것만 남겨 `{"productCode": code, "note": ""}`
   형태로 `cleanup_rows`를 만든다.
6. `all_rows = [{"productCode": r["productCode"], "note": output_note...} ...] + cleanup_rows`
7. `all_rows`가 비어 있으면 **EZAdmin 호출을 건너뛰고** `{"ok": True, "count": 0}`을 바로
   반환한다 (0건 정리 상황에서 빈 xls를 업로드하지 않도록).
8. `all_rows`가 있으면 기존과 동일하게 xls 생성 → C620 업로드 → 응답 파싱.
9. **EZAdmin 응답이 성공일 때만** 이력 테이블 갱신 (실패 시 아무 것도 건드리지 않음):
   - `output_note`가 실제 미래 날짜(`_DATE_RE` 매치 & `> today`)인 행: 해당
     `product_code`의 기존 이력을 전부 `DELETE` 후 `(product_code, note_date, exported_at)`
     새로 `INSERT` (재등록 시 이전 날짜 자동 대체).
   - `output_note`가 `""`인 행(3번 규칙으로 빈칸 처리된 것 + `cleanup_rows`): 해당
     `product_code`의 이력을 전부 `DELETE`.
   - `output_note`가 비-날짜 텍스트인 행: 이력 테이블 변경 없음.
10. 응답 형식은 기존과 동일하게 `{"ok": True, "count": int(...)}` /
    `{"ok": False, "error": ...}`.

## 프론트엔드 변경 (`src/components/ClientSchedule/ClientSchedulePage.jsx`)

`handleExportScheduleToEzadmin`(`725-769`)에서 **필터링·전송 페이로드 자체는 그대로**
유지한다(백엔드가 판정하므로). 변경할 부분은 "스케줄 0건이면 API 호출 자체를 막는" 가드
하나뿐이다.

```js
const scheduled = sheet2Rows.filter((row) => toDisplayText(row.D));
// 기존: scheduled.length === 0 이면 여기서 return하고 끝 → 삭제
// (정리 대상 이력만 있어도 백엔드를 호출해야 하므로, 0건이어도 계속 진행)
```

- `missingCode` 체크는 그대로 `scheduled`에 대해서만 수행 (0건이면 자연히 통과).
- `confirm()` 문구는 그대로 `${scheduled.length}건을 EZAdmin에 반영합니다` 사용 —
  0건일 때 "0건을 EZAdmin에 반영합니다"로 보여도 실제로는 정리만 수행되는 것이므로
  문구는 그대로 두되, 완료 메시지는 백엔드가 반환한 `count`(정리분 포함 합계)를
  그대로 표시하는 기존 로직(`EZAdmin 날짜 내보내기 완료 (${data.count}건 변경)`)을
  유지한다.
- 응답 처리(`need_session`, 에러 표시 등)는 변경 없음.

## 에러 / 엣지 케이스

- 상품코드 없는 스케줄 행 존재 → 기존과 동일하게 전체 차단(변경 없음).
- 스케줄 0건 + 정리 대상도 0건 → 백엔드가 EZAdmin 호출 없이 `count: 0` 즉시 반환.
- 같은 상품코드가 "오늘 지난 날짜로 남아있는 현재 스케줄"이면서 동시에 "예전 이력에도
  걸리는" 경우 → `current_codes` 필터로 이력 조회 시 제외되므로 중복 전송 없음
  (3번 규칙에 의해 이미 빈칸으로 전송되고, 이력은 정리됨).
- EZAdmin 응답 실패(HTTP 오류, 성공 문구 파싱 실패, 세션 만료) → 이력 테이블은 전혀
  갱신하지 않는다(9단계는 성공 시에만 실행) — 다음 재시도 때 같은 정리 대상이 다시
  계산되므로 데이터 유실 없음.
- 비-날짜 텍스트(`이번주중` 등)는 이력 테이블에 절대 들어가지 않으므로, 이번 자동 정리
  기능과 무관하게 기존 `normalizeDValueForMerge` 만료 로직만 적용된다.

## 범위 밖 (Out of scope)

- 이력 테이블에 감사(audit) 목적의 상태 플래그나 조회 API는 만들지 않는다(정리 즉시 삭제).
- `client_schedule_db`(현재 스케줄 원본 데이터) 저장/조회 로직 변경 없음.
- 완료 메시지에 "정리 N건" 별도 표기는 하지 않는다(총 건수만 표시).
