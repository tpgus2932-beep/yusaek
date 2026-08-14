# 아무드 이지어드민 엑셀 - 최근 불러온 이력(3개) 복원 기능

## 배경

`바코드 > 아무드` 탭의 "② 이지어드민 엑셀" 섹션은 "API로 불러오기"(EZAdmin에서 직접 조회) 또는 "직접 업로드"로 엑셀을 불러온다. 이 파일은 `SHARED_AMOOD_EZADMIN_FILE`(전역 공유, 전 사용자 공통)로 관리되며, DB의 `amood_ezadmin_file` 테이블에 **딱 1행(현재 활성 파일)만** 저장되어 서버 재시작 시 복원된다.

문제: 새로 불러오거나 "업로드 초기화"를 누르면 이 1행이 덮어써지거나 삭제되어, 직전에 불러왔던 이지어드민 엑셀이 완전히 사라진다. 실제로 이 문제로 작업 중이던 엑셀 데이터가 유실된 사례가 있었다.

## 범위

- 이력을 남기는 트리거는 **`POST /amood/load-from-ezadmin`(API로 불러오기) 성공 시만**이다. `POST /amood/excel2`(수동 업로드)는 이력에 남기지 않는다.
- `POST /amood/reset`(업로드 초기화)은 기존과 동일하게 "현재 활성 파일" 슬롯(`amood_ezadmin_file` 테이블)만 비운다. 새로 추가하는 이력 테이블(`amood_ezadmin_history`)은 초기화의 영향을 받지 않는다.
- "① 아무드(Pastelco API)" 쪽은 이번 범위에 포함하지 않는다.

## 백엔드 설계

### 새 테이블: `amood_ezadmin_history`

```sql
CREATE TABLE IF NOT EXISTS amood_ezadmin_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_blob BLOB NOT NULL,
    saved_at TEXT NOT NULL
)
```

기존 `amood_ezadmin_file`(id=1 고정, 현재 활성 파일 전용)과는 별개 테이블이다. `_get_shared_db()`를 사용해 기존 `amood_ezadmin_file`과 동일한 DB 커넥션 전략(로컬 SQLite / Turso)을 따른다.

### `backend/main.py`에 추가할 함수

- `_init_amood_ezadmin_history_table(conn)` — 테이블 생성 (기존 `_init_amood_ezadmin_file_table`과 같은 패턴).
- `_add_amood_ezadmin_history(file_name: str, file_bytes: bytes)` — 새 행 삽입 후, `id DESC` 기준 최신 3개만 남기고 나머지 삭제.
- `_list_amood_ezadmin_history() -> list[dict]` — `id`, `file_name`, `saved_at`만 조회(블롭 제외), `saved_at` 최신순(= `id DESC`) 최대 3개 반환.
- `_get_amood_ezadmin_history_blob(history_id: int) -> tuple[str, bytes] | None` — 특정 id의 `file_name`, `file_blob` 조회.

이 세 함수(`add_amood_ezadmin_history`, `list_amood_ezadmin_history`, `get_amood_ezadmin_history_blob`)는 기존 `set_shared_amood_ezadmin_file`과 동일하게 `build_amood_router(...)` 호출부(`main.py`에서 라우터 등록하는 곳)에 새 키워드 인자로 추가해 주입한다.

### `backend/api/amood_routes.py` 변경

1. `build_amood_router(...)` 시그니처에 `add_amood_ezadmin_history`, `list_amood_ezadmin_history`, `get_amood_ezadmin_history_blob` 파라미터 추가.
2. 기존 `amood_load_from_ezadmin` 핸들러에서 `wb.save(tmp_path)` 직후, `set_shared_amood_ezadmin_file({...})` 호출과 함께 `add_amood_ezadmin_history(file2_name, tmp_path.read_bytes())`도 호출한다.
3. 새 엔드포인트 `GET /amood/ezadmin-history`:
   ```python
   @router.get("/amood/ezadmin-history")
   def amood_ezadmin_history(user: str = Depends(get_current_user)):
       return {"ok": True, "history": list_amood_ezadmin_history()}
   ```
4. 새 엔드포인트 `POST /amood/ezadmin-history/{history_id}/restore`:
   - `get_amood_ezadmin_history_blob(history_id)`로 조회, 없으면 404.
   - blob을 임시 파일(`amood_excel2_history_restore_{uuid}.xlsx`)로 저장.
   - 기존 `set_shared_amood_ezadmin_file({"file2_path": tmp_path, "file2_name": file_name})` 호출로 "현재 활성 파일"로 반영 (전 사용자 공유, 서버 재시작 복원용 슬롯도 함께 갱신됨).
   - 이 복원 동작 자체는 `add_amood_ezadmin_history`를 호출하지 않는다 (이력에 다시 안 쌓임).
   - 응답: `{"ok": True, "status": amood_status(state)}` (기존 load 엔드포인트들과 동일한 응답 형태).

## 프론트엔드 설계 (`src/components/Barcode/AmoodBarcodePage.jsx`)

- 새 state: `ezadminHistory` (배열, 기본 `[]`), `historyLoading` (bool), `restoringId` (복원 중인 history id 또는 `null`).
- `refreshEzadminHistory()` 함수: `GET /amood/ezadmin-history` 호출해 `ezadminHistory` 갱신. 컴포넌트 마운트 시(`refreshStatus`와 같은 최초 `useEffect`) 1회 호출.
- `loadFromEzadmin` 성공 후 기존 `refreshStatus()` 호출과 나란히 `refreshEzadminHistory()`도 호출.
- 새 함수 `restoreEzadminHistory(id)`:
  - `window.confirm`으로 "현재 이지어드민 엑셀을 이 이력으로 되돌리시겠습니까?" 확인.
  - `POST /amood/ezadmin-history/{id}/restore` 호출, 성공 시 `setMessage(...)` + `refreshStatus()`.
  - 로딩 중에는 `restoringId`를 설정해 해당 항목 버튼만 비활성화.
- UI: "② 이지어드민 엑셀" 카드에서 "API로 불러오기" 버튼이 있는 `uploadRow` 아래에 새 블록 추가:
  - `ezadminHistory.length > 0`일 때만 표시.
  - 각 항목: 파일명 + 저장 시각(`formatSavedAt` 재사용) + "복원" 버튼(`restoringId === item.id`이면 "복원 중...").
  - 항목 없으면 아무것도 표시하지 않음 (빈 상태 문구 불필요 — 카드가 이미 붐빔).

## 엣지 케이스

- 이력이 하나도 없는 경우(신규 설치, 아직 API로 불러오기를 한 번도 안 한 경우): `GET /amood/ezadmin-history`는 빈 배열 반환, UI에 이력 블록 자체를 숨김.
- `history_id`가 존재하지 않는 경우(이미 3개 초과로 삭제됨 등 레이스 컨디션): 404 반환, 프론트는 에러 메시지 표시 후 이력 목록 재조회.
- 이력 테이블의 블롭 크기: 기존 `amood_ezadmin_file`도 동일한 방식으로 blob을 저장하고 있어 추가 위험 없음 (엑셀 파일 크기는 수백 KB~수 MB 수준).
