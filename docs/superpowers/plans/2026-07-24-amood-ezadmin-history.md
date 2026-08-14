# 아무드 이지어드민 엑셀 최근 이력(3개) 복원 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아무드 탭 "② 이지어드민 엑셀"에서 "API로 불러오기"로 성공적으로 불러올 때마다 그 엑셀을 이력에 저장하고, 최근 3개까지 화면에서 다시 복원(현재 활성 파일로 되돌리기)할 수 있게 한다.

**Architecture:** `backend/main.py`에 신규 테이블 `amood_ezadmin_history`(최근 3개 유지)와 이를 다루는 헬퍼 함수 4개를 추가하고, 기존 `build_amood_router(...)` 주입 패턴대로 `backend/api/amood_routes.py`에 넘긴다. `amood_load_from_ezadmin` 핸들러가 성공할 때마다 이력에 기록하고, 새 엔드포인트 2개(`GET /amood/ezadmin-history`, `POST /amood/ezadmin-history/{id}/restore`)로 조회·복원을 제공한다. 프론트엔드 `AmoodBarcodePage.jsx`는 이 엔드포인트를 호출해 "최근 불러온 이력" 목록과 "복원" 버튼을 보여준다.

**Tech Stack:** FastAPI (Python), sqlite3/Turso 공유 DB(`_get_shared_db()`), React 19 (기존 fetch 패턴).

## Global Constraints

- 이력을 남기는 트리거는 `POST /amood/load-from-ezadmin`(API로 불러오기) 성공 시만이다. `POST /amood/excel2`(수동 업로드)와 `POST /amood/ezadmin-history/{id}/restore`(복원 자체)는 이력에 새로 안 쌓인다.
- `POST /amood/reset`(업로드 초기화)은 `amood_ezadmin_history` 테이블을 건드리지 않는다 (기존 `_amood_reset_state`/`_set_shared_amood_ezadmin_file(None)` 로직 변경 없음).
- **백엔드 서버(port 8000, `--reload` 없음)는 현재 다른 사용자들이 실시간으로 접속해 바코드 스캔 중이므로, 이번 작업에서는 코드만 수정·커밋하고 서버는 재시작하지 않는다.** 재시작은 사용자가 나중에 직접 한다. 따라서 백엔드 검증은 실제 서버(curl)가 아니라 `python -m py_compile`과 격리된 임시 SQLite 파일을 이용한 로직 검증으로 진행한다.
- 커밋마다 정확한 파일만 `git add`하고, `git commit`은 각 태스크 끝에서 1회.

---

### Task 1: 이력 테이블/헬퍼 함수 추가 (`backend/main.py`)

**Files:**
- Modify: `backend/main.py`

**Interfaces:**
- Produces: 모듈 함수 `_add_amood_ezadmin_history(file_name: str, file_bytes: bytes) -> None`, `_list_amood_ezadmin_history() -> list[dict]` (각 dict: `id`, `file_name`, `saved_at`), `_get_amood_ezadmin_history_blob(history_id: int) -> tuple[str, bytes] | None`. Task 2에서 `build_amood_router(...)` 호출부에 그대로 주입해 사용한다.

- [ ] **Step 1: 이력 테이블/헬퍼 함수 추가**

`backend/main.py`에서 다음 블록을 찾는다 (`_restore_amood_ezadmin_file_from_db` 함수의 끝, `_get_amood_state` 함수의 시작 직전):

```python
    SHARED_AMOOD_EZADMIN_FILE.update({
        "file2_path": tmp_path,
        "file2_name": row["file_name"],
        "saved_at": row["saved_at"],
    })


def _get_amood_state(user: str) -> AmoodState:
```

다음으로 교체한다:

```python
    SHARED_AMOOD_EZADMIN_FILE.update({
        "file2_path": tmp_path,
        "file2_name": row["file_name"],
        "saved_at": row["saved_at"],
    })


def _init_amood_ezadmin_history_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS amood_ezadmin_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            file_blob BLOB NOT NULL,
            saved_at TEXT NOT NULL
        )
    """)
    conn.commit()


def _add_amood_ezadmin_history(file_name: str, file_bytes: bytes):
    conn = _get_shared_db()
    try:
        _init_amood_ezadmin_history_table(conn)
        saved_at = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO amood_ezadmin_history (file_name, file_blob, saved_at) VALUES (?, ?, ?)",
            (file_name, file_bytes, saved_at),
        )
        conn.execute(
            "DELETE FROM amood_ezadmin_history WHERE id NOT IN (SELECT id FROM amood_ezadmin_history ORDER BY id DESC LIMIT 3)"
        )
        conn.commit()
    finally:
        conn.close()


def _list_amood_ezadmin_history() -> list[dict]:
    conn = _get_shared_db()
    try:
        _init_amood_ezadmin_history_table(conn)
        rows = conn.execute(
            "SELECT id, file_name, saved_at FROM amood_ezadmin_history ORDER BY id DESC LIMIT 3"
        ).fetchall()
    finally:
        conn.close()
    return [{"id": r["id"], "file_name": r["file_name"], "saved_at": r["saved_at"]} for r in rows]


def _get_amood_ezadmin_history_blob(history_id: int):
    conn = _get_shared_db()
    try:
        _init_amood_ezadmin_history_table(conn)
        row = conn.execute(
            "SELECT file_name, file_blob FROM amood_ezadmin_history WHERE id = ?",
            (history_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return row["file_name"], row["file_blob"]


def _get_amood_state(user: str) -> AmoodState:
```

- [ ] **Step 2: `build_amood_router(...)` 호출부에 새 함수 3개 주입**

`backend/main.py`에서 다음 블록을 찾는다:

```python
        set_shared_amood_ezadmin_file=_set_shared_amood_ezadmin_file,
    )
)
app.include_router(
    build_returns_router(
```

다음으로 교체한다:

```python
        set_shared_amood_ezadmin_file=_set_shared_amood_ezadmin_file,
        add_amood_ezadmin_history=_add_amood_ezadmin_history,
        list_amood_ezadmin_history=_list_amood_ezadmin_history,
        get_amood_ezadmin_history_blob=_get_amood_ezadmin_history_blob,
    )
)
app.include_router(
    build_returns_router(
```

이 시점에서는 `build_amood_router`(`amood_routes.py`)가 아직 이 새 키워드 인자들을 받지 않으므로, `py_compile`은 통과하지만 서버를 실제로 기동하면 `TypeError: build_amood_router() got an unexpected keyword argument`가 난다. Task 2에서 `amood_routes.py` 시그니처를 맞추기 전까지는 서버를 기동하지 않는다 (어차피 이번 태스크에서는 서버 재시작을 하지 않기로 했다).

- [ ] **Step 3: 문법 검사**

Run: `cd backend && python -m py_compile main.py`
Expected: 출력 없이 종료 (문법 에러 없음). *(참고: 이 검사는 문법만 확인하며, `build_amood_router` 인자 불일치 같은 런타임 오류는 잡아내지 못한다 — 그건 Task 2 완료 후 Step에서 확인한다.)*

- [ ] **Step 4: 격리된 임시 SQLite로 이력 prune 로직 검증**

실제 운영 DB(`app.db`)를 건드리지 않기 위해, 동일한 SQL을 임시 파일에 대해 직접 실행해 prune 로직(최신 3개만 유지)이 의도대로 동작하는지 확인한다.

`backend` 디렉터리에서 다음을 실행:

```bash
python - <<'PYEOF'
import sqlite3, tempfile, os

path = os.path.join(tempfile.gettempdir(), "amood_history_test.db")
if os.path.exists(path):
    os.remove(path)
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
conn.execute("""
    CREATE TABLE IF NOT EXISTS amood_ezadmin_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        file_blob BLOB NOT NULL,
        saved_at TEXT NOT NULL
    )
""")
for i in range(1, 5):
    conn.execute(
        "INSERT INTO amood_ezadmin_history (file_name, file_blob, saved_at) VALUES (?, ?, ?)",
        (f"file_{i}.xlsx", f"blob_{i}".encode(), f"2026-07-2{i}T00:00:00"),
    )
    conn.execute(
        "DELETE FROM amood_ezadmin_history WHERE id NOT IN (SELECT id FROM amood_ezadmin_history ORDER BY id DESC LIMIT 3)"
    )
    conn.commit()

rows = conn.execute("SELECT id, file_name, saved_at FROM amood_ezadmin_history ORDER BY id DESC LIMIT 3").fetchall()
names = [r["file_name"] for r in rows]
assert names == ["file_4.xlsx", "file_3.xlsx", "file_2.xlsx"], names
print("OK:", names)
conn.close()
os.remove(path)
PYEOF
```

Expected 출력: `OK: ['file_4.xlsx', 'file_3.xlsx', 'file_2.xlsx']` (4번째 삽입 후에도 3개만 남고, 가장 오래된 `file_1.xlsx`는 삭제됨).

- [ ] **Step 5: 커밋**

```bash
git add backend/main.py
git commit -m "feat: 아무드 이지어드민 이력 테이블/헬퍼 함수 추가"
```

---

### Task 2: 이력 기록 훅 + 조회/복원 엔드포인트 (`backend/api/amood_routes.py`)

**Files:**
- Modify: `backend/api/amood_routes.py`

**Interfaces:**
- Consumes: Task 1의 `_add_amood_ezadmin_history`, `_list_amood_ezadmin_history`, `_get_amood_ezadmin_history_blob` (main.py에서 `add_amood_ezadmin_history`, `list_amood_ezadmin_history`, `get_amood_ezadmin_history_blob`라는 이름으로 주입됨).
- Produces: `GET /amood/ezadmin-history` → `{"ok": true, "history": [{"id", "file_name", "saved_at"}, ...]}`, `POST /amood/ezadmin-history/{history_id}/restore` → `{"ok": true, "status": {...}}` (404 if not found). Task 3 프론트엔드가 이 두 응답 shape을 그대로 사용한다.

- [ ] **Step 1: `build_amood_router` 시그니처에 새 파라미터 추가**

`backend/api/amood_routes.py`에서 다음 블록을 찾는다:

```python
    get_shared_defect_counts,
    set_shared_amood_ezadmin_file,
):
    router = APIRouter()
```

다음으로 교체한다:

```python
    get_shared_defect_counts,
    set_shared_amood_ezadmin_file,
    add_amood_ezadmin_history,
    list_amood_ezadmin_history,
    get_amood_ezadmin_history_blob,
):
    router = APIRouter()
```

- [ ] **Step 2: `amood_load_from_ezadmin` 핸들러가 성공 시 이력에 기록하도록 수정**

같은 파일에서 다음 블록을 찾는다:

```python
        tmp_path = Path(tempfile.gettempdir()) / f"amood_excel2_ezadmin_{uuid.uuid4().hex}.xlsx"
        wb.save(tmp_path)

        set_shared_amood_ezadmin_file({
            "file2_path": tmp_path,
            "file2_name": f"이지어드민_{start_date}_{end_date}.xlsx",
        })
        state = get_amood_state(user)

        return {
            "ok": True,
            "count": len(expanded_rows),
            "management_numbers": seen_seq,
            "status": amood_status(state),
        }
```

다음으로 교체한다:

```python
        tmp_path = Path(tempfile.gettempdir()) / f"amood_excel2_ezadmin_{uuid.uuid4().hex}.xlsx"
        wb.save(tmp_path)

        file2_name = f"이지어드민_{start_date}_{end_date}.xlsx"
        set_shared_amood_ezadmin_file({
            "file2_path": tmp_path,
            "file2_name": file2_name,
        })
        add_amood_ezadmin_history(file2_name, tmp_path.read_bytes())
        state = get_amood_state(user)

        return {
            "ok": True,
            "count": len(expanded_rows),
            "management_numbers": seen_seq,
            "status": amood_status(state),
        }
```

- [ ] **Step 3: 이력 조회/복원 엔드포인트 추가**

같은 파일에서 다음 블록을 찾는다 (`amood_load_from_ezadmin` 핸들러 끝, `amood_hapbae_pack` 핸들러 시작 직전):

```python
            "status": amood_status(state),
        }

    @router.post("/amood/hapbae-pack")
```

다음으로 교체한다:

```python
            "status": amood_status(state),
        }

    @router.get("/amood/ezadmin-history")
    def amood_ezadmin_history_list(user: str = Depends(get_current_user)):
        return {"ok": True, "history": list_amood_ezadmin_history()}

    @router.post("/amood/ezadmin-history/{history_id}/restore")
    def amood_ezadmin_history_restore(history_id: int, user: str = Depends(get_current_user)):
        found = get_amood_ezadmin_history_blob(history_id)
        if not found:
            raise HTTPException(status_code=404, detail="이력을 찾을 수 없습니다.")
        file_name, file_blob = found
        tmp_path = Path(tempfile.gettempdir()) / f"amood_excel2_history_restore_{uuid.uuid4().hex}.xlsx"
        tmp_path.write_bytes(file_blob)
        set_shared_amood_ezadmin_file({
            "file2_path": tmp_path,
            "file2_name": file_name,
        })
        state = get_amood_state(user)
        return {"ok": True, "status": amood_status(state)}

    @router.post("/amood/hapbae-pack")
```

- [ ] **Step 4: main.py ↔ amood_routes.py 인자 일치 확인 (문법 검사 + 정적 확인)**

Run: `cd backend && python -m py_compile main.py api/amood_routes.py`
Expected: 출력 없이 종료.

이어서 두 파일에서 `build_amood_router` 키워드 인자 이름이 정확히 일치하는지 눈으로 대조한다 (양쪽 모두 `add_amood_ezadmin_history`, `list_amood_ezadmin_history`, `get_amood_ezadmin_history_blob`):

```bash
grep -n "add_amood_ezadmin_history\|list_amood_ezadmin_history\|get_amood_ezadmin_history_blob" main.py api/amood_routes.py
```

Expected: `main.py`의 함수 정의 3개 + 호출부 3개, `api/amood_routes.py`의 파라미터 선언 3개 + 실제 사용 코드가 모두 이름이 정확히 같아야 한다 (오탈자 없음).

- [ ] **Step 5: 커밋**

```bash
git add backend/api/amood_routes.py
git commit -m "feat: 이지어드민 API 불러오기 이력 기록 + 조회/복원 엔드포인트 추가"
```

---

### Task 3: 프론트엔드 - 이력 목록 UI + 복원 (`src/components/Barcode/AmoodBarcodePage.jsx`)

**Files:**
- Modify: `src/components/Barcode/AmoodBarcodePage.jsx`

**Interfaces:**
- Consumes: Task 2의 `GET /amood/ezadmin-history` (`{"ok", "history": [{"id","file_name","saved_at"}]}`), `POST /amood/ezadmin-history/{id}/restore` (`{"ok", "status"}`).

- [ ] **Step 1: state 추가 및 이력 조회 함수 작성**

`src/components/Barcode/AmoodBarcodePage.jsx`에서 다음 블록을 찾는다:

```jsx
  const [mgmtNumbers, setMgmtNumbers] = useState([]);
  const [packLoading, setPackLoading] = useState(false);

  const refreshStatus = async () => {
```

다음으로 교체한다:

```jsx
  const [mgmtNumbers, setMgmtNumbers] = useState([]);
  const [packLoading, setPackLoading] = useState(false);
  const [ezadminHistory, setEzadminHistory] = useState([]);
  const [restoringId, setRestoringId] = useState(null);

  const refreshEzadminHistory = async () => {
    try {
      const res = await fetch(`${API}/amood/ezadmin-history`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setEzadminHistory(data.history || []);
    } catch {
      // ignore
    }
  };

  const restoreEzadminHistory = async (id) => {
    if (!window.confirm("현재 이지어드민 엑셀을 이 이력으로 되돌리시겠습니까?")) return;
    setRestoringId(id);
    setMessage("");
    try {
      const res = await fetch(`${API}/amood/ezadmin-history/${id}/restore`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "이력 복원 실패");
      setMessage("이지어드민 엑셀을 이력으로 복원했습니다.");
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "이력 복원 실패");
    } finally {
      setRestoringId(null);
    }
  };

  const refreshStatus = async () => {
```

- [ ] **Step 2: 마운트 시 이력 조회 + API 불러오기 성공 시 이력 갱신**

같은 파일에서 다음 블록을 찾는다:

```jsx
  useEffect(() => {
    refreshStatus();
    setTimeout(() => scanRef.current?.focus(), 50);
  }, []);
```

다음으로 교체한다:

```jsx
  useEffect(() => {
    refreshStatus();
    refreshEzadminHistory();
    setTimeout(() => scanRef.current?.focus(), 50);
  }, []);
```

이어서 같은 파일에서 다음 블록을 찾는다:

```jsx
      if (data.management_numbers?.length) {
        setMgmtNumbers(data.management_numbers);
        setEasyadminBPreviewText(data.management_numbers.join(", "));
        setEasyadminBCopyMessage("");
        setEasyadminBPreviewOpen(true);
      }
      await refreshStatus();
    } catch (err) {
      setMessage(err.message || "이지어드민 불러오기 실패");
    } finally {
      setLoadingEzadmin(false);
    }
  };
```

다음으로 교체한다:

```jsx
      if (data.management_numbers?.length) {
        setMgmtNumbers(data.management_numbers);
        setEasyadminBPreviewText(data.management_numbers.join(", "));
        setEasyadminBCopyMessage("");
        setEasyadminBPreviewOpen(true);
      }
      await refreshStatus();
      await refreshEzadminHistory();
    } catch (err) {
      setMessage(err.message || "이지어드민 불러오기 실패");
    } finally {
      setLoadingEzadmin(false);
    }
  };
```

- [ ] **Step 3: "② 이지어드민 엑셀" 카드에 이력 목록 UI 추가**

같은 파일에서 다음 블록을 찾는다:

```jsx
                {status?.ezadmin_saved_at && (
                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    저장 일시: {formatSavedAt(status.ezadmin_saved_at)}
                  </span>
                )}
              </div>
              <div className={styles.uploadRow}>
                <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
                  <input
                    key={`file2-${fileInputKey}`}
```

다음으로 교체한다:

```jsx
                {status?.ezadmin_saved_at && (
                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    저장 일시: {formatSavedAt(status.ezadmin_saved_at)}
                  </span>
                )}
              </div>
              {ezadminHistory.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.4rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>최근 불러온 이력</span>
                  {ezadminHistory.map((h) => (
                    <div
                      key={h.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        fontSize: "0.78rem",
                        padding: "0.3rem 0.5rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                      }}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {h.file_name}
                      </span>
                      <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {formatSavedAt(h.saved_at)}
                      </span>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => restoreEzadminHistory(h.id)}
                        disabled={restoringId === h.id}
                      >
                        {restoringId === h.id ? "복원 중..." : "복원"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.uploadRow}>
                <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
                  <input
                    key={`file2-${fileInputKey}`}
```

- [ ] **Step 4: lint 검사**

Run: `npm run lint`
Expected: `AmoodBarcodePage.jsx` 관련 에러 없음.

- [ ] **Step 5: 코드 리뷰 (백엔드 미기동 상태이므로 브라우저 실동작 확인은 서버 재시작 후 사용자가 직접 진행)**

`AmoodBarcodePage.jsx`에서 새로 추가한 `refreshEzadminHistory`/`restoreEzadminHistory`/이력 UI 블록을 다시 읽고 다음을 확인한다:
- `ezadminHistory` 배열이 비어 있을 때 이력 블록 자체가 렌더링되지 않는다 (조건부 렌더링 `ezadminHistory.length > 0`).
- `restoringId`가 해당 항목의 `h.id`와 일치할 때만 그 버튼이 "복원 중..."으로 바뀌고 비활성화된다 (다른 항목은 그대로 클릭 가능).
- API 불러오기(`loadFromEzadmin`) 실패 시(catch 블록)에는 `refreshEzadminHistory()`를 호출하지 않아, 실패한 시도가 이력에 잘못 반영되지 않는다.

- [ ] **Step 6: 커밋**

```bash
git add src/components/Barcode/AmoodBarcodePage.jsx
git commit -m "feat: 아무드 이지어드민 최근 불러온 이력 3개 표시 및 복원 UI 추가"
```

---

### 마무리 안내 (구현 완료 후)

이 플랜의 모든 태스크는 **백엔드 서버를 재시작하지 않은 상태**로 완료된다. 코드는 커밋되어 있지만 실제로 새 엔드포인트(`/amood/ezadmin-history`, `/amood/ezadmin-history/{id}/restore`)가 살아있는 서버에 반영되려면, 사용자가 편한 시점에 `main:app` 프로세스(port 8000, PID로 확인 후 `taskkill` 또는 정상 종료 → 재기동)를 재시작해야 한다. 재시작 후 브라우저에서 아무드 탭 → API로 불러오기 → 이력 항목 표시 확인 → 복원 클릭까지 실제로 확인하는 것을 권장한다.
