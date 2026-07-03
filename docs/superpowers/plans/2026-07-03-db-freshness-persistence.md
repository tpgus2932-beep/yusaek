# DB 업데이트 관리 최신화 확인 통합·영구저장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드의 "최신화 확인" 버튼 하나로 원가베이스유 최신화 확인 + 입고대기 최신업데이트 + 에이블리재고변경 최신업데이트를 한번에 실행하고, 그 결과를 DB에 저장해 새로고침/재접속해도 마지막 상태(파란불/빨간불, 확인 시각, 각 항목 추가 건수)가 계속 표시되게 한다.

**Architecture:** 백엔드 `backend/api/wonbe_routes.py`의 기존 `POST /wonbe/freshness-check` 핸들러가 기존 에이블리 최신화 판정 로직에 더해 `입고대기`/`에이블리재고변경` 동기화 헬퍼를 호출하고, 결과를 기존 `wonbe_meta` key-value 테이블에 저장한다. 새 `GET /wonbe/freshness-status`가 저장된 값을 읽어 반환한다. 프론트 `src/components/Dashboard/Overview.jsx`는 마운트 시 이 GET을 호출해 `freshnessResult`를 초기화하고, 화면에 확인 시각·추가 건수를 추가로 표시한다.

**Tech Stack:** FastAPI (Python), sqlite3, React (기존 fetch 기반 API 호출 패턴). 이 저장소에는 자동화 테스트 스위트가 없으므로(백엔드 pytest 없음, 프론트 jest/vitest 없음) 각 태스크의 검증은 `curl` 수동 호출과 브라우저 수동 확인으로 진행한다.

## Global Constraints

- 백엔드 서버는 `--reload` 없이 실행되는 경우가 있으므로, 코드 수정 후 검증 전에 서버가 재시작되었는지 반드시 확인한다(`netstat`으로 PID 확인 후 필요시 재시작).
- `wonbe_meta`는 기존에 `last_sync_at`, `last_sync_count`, `last_sync_fetched` 키를 이미 저장 중인 key-value 테이블이다 — 새 테이블을 만들지 않고 이 테이블에 키만 추가한다.
- 기존 `POST /wonbe/ingodaegi/sync-from-wonbe`, `POST /wonbe/ably-stock/sync-from-wonbe`, `DB관리` 탭의 개별 버튼(`IngodaegiTable.jsx`, `AblyStockTable.jsx`)은 동작이 바뀌면 안 된다(응답 shape 그대로 `{"ok": true, "added": N}`).
- 커밋마다 정확한 파일만 `git add`하고, `git commit`은 각 태스크 끝에서 1회.

---

### Task 1: `입고대기`/`에이블리재고변경` 동기화 로직을 모듈 함수로 추출

**Files:**
- Modify: `backend/api/wonbe_routes.py:111-128` (헬퍼 함수 추가), `backend/api/wonbe_routes.py:369-389` (`ingodaegi_sync_from_wonbe` 핸들러), `backend/api/wonbe_routes.py:495-515` (`ably_stock_sync_from_wonbe` 핸들러)

**Interfaces:**
- Produces: 모듈 레벨 함수 `_sync_ingodaegi_from_wonbe(conn: sqlite3.Connection) -> int` (추가된 상품코드 수 반환), `_sync_ably_stock_from_wonbe(conn: sqlite3.Connection) -> int` (추가된 옵션번호 수 반환). Task 2에서 이 두 함수를 그대로 호출한다.

이 두 함수는 이미 `wonbe_meta` 접근에 쓰이는 `_init_wonbe_table`, `_init_ingodaegi_table`, `_init_ably_stock_table`와 나란히 모듈 레벨에 정의되어 있어야 한다(클래스/라우터 안이 아님).

- [ ] **Step 1: `_init_ingodaegi_table` 바로 뒤에 `_sync_ingodaegi_from_wonbe` 헬퍼 추가**

`backend/api/wonbe_routes.py`에서 118번 줄(`_init_ingodaegi_table` 끝, `conn.commit()` 다음 빈 줄) 뒤에 삽입:

```python
def _sync_ingodaegi_from_wonbe(conn: sqlite3.Connection) -> int:
    _init_wonbe_table(conn)
    _init_ingodaegi_table(conn)
    rows = conn.execute(
        """SELECT 상품코드 FROM wonbe
           WHERE TRIM(상품코드) != ''
             AND 상품코드 NOT IN (SELECT 상품코드 FROM 입고대기)"""
    ).fetchall()
    new_codes = [(r["상품코드"],) for r in rows]
    if new_codes:
        conn.executemany(
            "INSERT OR IGNORE INTO 입고대기 (상품코드, 입고수량) VALUES (?, 'ZERO')",
            new_codes,
        )
        conn.commit()
    return len(new_codes)
```

- [ ] **Step 2: `_init_ably_stock_table` 바로 뒤에 `_sync_ably_stock_from_wonbe` 헬퍼 추가**

같은 파일에서 `_init_ably_stock_table` 끝(원래 128번 줄 부근, Step 1로 줄 번호가 밀린 뒤) 뒤에 삽입:

```python
def _sync_ably_stock_from_wonbe(conn: sqlite3.Connection) -> int:
    _init_wonbe_table(conn)
    _init_ably_stock_table(conn)
    rows = conn.execute(
        """SELECT 옵션번호 FROM wonbe
           WHERE TRIM(옵션번호) != ''
             AND 옵션번호 NOT IN (SELECT 옵션번호 FROM 에이블리재고변경)"""
    ).fetchall()
    new_options = [(r["옵션번호"],) for r in rows]
    if new_options:
        conn.executemany(
            "INSERT OR IGNORE INTO 에이블리재고변경 (옵션번호, 수량) VALUES (?, '0')",
            new_options,
        )
        conn.commit()
    return len(new_options)
```

- [ ] **Step 3: 기존 `/ingodaegi/sync-from-wonbe` 핸들러가 헬퍼를 쓰도록 교체**

`ingodaegi_sync_from_wonbe` 핸들러 본문(원래 370~389번 줄)을 다음으로 교체 (라우트 데코레이터와 함수 시그니처는 그대로 유지):

```python
    @router.post("/ingodaegi/sync-from-wonbe")
    def ingodaegi_sync_from_wonbe(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            added = _sync_ingodaegi_from_wonbe(conn)
            return {"ok": True, "added": added}
        finally:
            conn.close()
```

- [ ] **Step 4: 기존 `/ably-stock/sync-from-wonbe` 핸들러가 헬퍼를 쓰도록 교체**

`ably_stock_sync_from_wonbe` 핸들러 본문(원래 496~515번 줄)을 다음으로 교체:

```python
    @router.post("/ably-stock/sync-from-wonbe")
    def ably_stock_sync_from_wonbe(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            added = _sync_ably_stock_from_wonbe(conn)
            return {"ok": True, "added": added}
        finally:
            conn.close()
```

- [ ] **Step 5: 문법 검사**

Run: `cd backend && python -m py_compile api/wonbe_routes.py`
Expected: 출력 없이 종료 (에러 없음)

- [ ] **Step 6: 백엔드 서버 재시작 확인 후 기존 두 엔드포인트가 그대로 동작하는지 curl로 확인**

서버가 `--reload` 없이 떠 있다면 재시작 필요. 재시작 후:

```bash
TOKEN='<로그인 후 localStorage.getItem("token") 값>'
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/wonbe/ingodaegi/sync-from-wonbe
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/wonbe/ably-stock/sync-from-wonbe
```

Expected: 둘 다 `{"ok":true,"added":<정수>}` 형태로 응답 (리팩터링 전과 동일한 shape). 두 번째 호출부터는 `added`가 대체로 0에 수렴(이미 동기화된 코드는 다시 추가되지 않으므로 — `INSERT OR IGNORE` 특성상 정상).

- [ ] **Step 7: Commit**

```bash
git add backend/api/wonbe_routes.py
git commit -m "$(cat <<'EOF'
Extract ingodaegi/ably-stock sync-from-wonbe logic into reusable helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `POST /wonbe/freshness-check`가 세 작업을 한번에 실행하고 결과를 저장

**Files:**
- Modify: `backend/api/wonbe_routes.py:885-971` (`wonbe_freshness_check` 핸들러 — Task 1에서 줄 번호가 위로 밀렸을 수 있으니 `@router.post("/freshness-check")`로 검색해서 찾을 것)

**Interfaces:**
- Consumes: Task 1에서 만든 `_sync_ingodaegi_from_wonbe(conn)`, `_sync_ably_stock_from_wonbe(conn)`.
- Produces: `POST /wonbe/freshness-check` 응답에 새 필드 `checked_at`(str), `ingodaegi_added`(int), `ablystock_added`(int) 추가. `wonbe_meta`에 7개 키(`freshness_status`, `freshness_checked_at`, `freshness_latest_created_at`, `freshness_checked_goods`, `freshness_checked_pages`, `freshness_ingodaegi_added`, `freshness_ablystock_added`) 저장. Task 3의 GET 엔드포인트가 이 7개 키를 읽는다.

- [ ] **Step 1: `wonbe_freshness_check` 핸들러의 마지막 절반(DB 조회~응답 반환)을 교체**

기존 코드에서 `conn = _get_wonbe_db()`로 시작해 함수 끝(`return {...}`)까지의 블록을 찾아 다음으로 통째로 교체한다. 그 앞부분(에이블리 로그인 → `latest_dt`/`checked_goods`/`checked_pages` 계산)은 전혀 건드리지 않는다:

```python
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            row = conn.execute("SELECT value FROM wonbe_meta WHERE key = 'last_sync_at'").fetchone()
            last_sync_at_str = row["value"] if row else None

            last_sync_dt = None
            if last_sync_at_str:
                try:
                    last_sync_dt = datetime.strptime(last_sync_at_str, "%Y-%m-%d %H:%M:%S")
                except Exception:
                    last_sync_dt = None

            if latest_dt is None:
                status = "blue"
            elif last_sync_dt is None or last_sync_dt < latest_dt:
                status = "red"
            else:
                status = "blue"

            ingodaegi_added = _sync_ingodaegi_from_wonbe(conn)
            ablystock_added = _sync_ably_stock_from_wonbe(conn)

            checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            latest_created_at = latest_dt.strftime("%Y-%m-%d %H:%M:%S") if latest_dt else None
            meta_values = {
                "freshness_status": status,
                "freshness_checked_at": checked_at,
                "freshness_latest_created_at": latest_created_at or "",
                "freshness_checked_goods": str(checked_goods),
                "freshness_checked_pages": str(checked_pages),
                "freshness_ingodaegi_added": str(ingodaegi_added),
                "freshness_ablystock_added": str(ablystock_added),
            }
            conn.executemany(
                "INSERT OR REPLACE INTO wonbe_meta (key, value) VALUES (?, ?)",
                list(meta_values.items()),
            )
            conn.commit()
        finally:
            conn.close()

        return {
            "ok": True,
            "status": status,
            "latest_created_at": latest_created_at,
            "last_sync_at": last_sync_at_str,
            "checked_goods": checked_goods,
            "checked_pages": checked_pages,
            "checked_at": checked_at,
            "ingodaegi_added": ingodaegi_added,
            "ablystock_added": ablystock_added,
        }
```

- [ ] **Step 2: 문법 검사**

Run: `cd backend && python -m py_compile api/wonbe_routes.py`
Expected: 에러 없음

- [ ] **Step 3: 서버 재시작 후 curl로 실행 및 저장 확인**

```bash
TOKEN='<token>'
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/wonbe/freshness-check
```

Expected: `{"ok":true,"status":"blue"|"red","latest_created_at":...,"last_sync_at":...,"checked_goods":N,"checked_pages":N,"checked_at":"YYYY-MM-DD HH:MM:SS","ingodaegi_added":N,"ablystock_added":N}` 형태로 응답. 에이블리 로그인이 실패하는 환경이면 502 에러가 그대로 나는 것이 정상(기존 동작 유지 확인).

- [ ] **Step 4: DB에 저장됐는지 직접 확인**

```bash
python -c "
import sqlite3
conn = sqlite3.connect(r'C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.db')
for row in conn.execute(\"SELECT key, value FROM wonbe_meta WHERE key LIKE 'freshness_%'\"):
    print(row)
"
```

Expected: 7개 `freshness_*` 키가 Step 3에서 받은 응답 값과 일치하게 출력됨.

- [ ] **Step 5: Commit**

```bash
git add backend/api/wonbe_routes.py
git commit -m "$(cat <<'EOF'
Persist freshness-check result and run ingodaegi/ably-stock sync together

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GET /wonbe/freshness-status` 엔드포인트 추가

**Files:**
- Modify: `backend/api/wonbe_routes.py` — `wonbe_freshness_check` 핸들러(Task 2에서 수정) 바로 다음, `@router.post("/janggi/save")` 바로 앞에 새 핸들러 삽입.

**Interfaces:**
- Consumes: Task 2에서 저장한 `wonbe_meta`의 7개 `freshness_*` 키 + 기존 `last_sync_at` 키.
- Produces: `GET /wonbe/freshness-status` — `POST /freshness-check`와 동일한 shape의 JSON(`ok`, `status`, `latest_created_at`, `last_sync_at`, `checked_goods`, `checked_pages`, `checked_at`, `ingodaegi_added`, `ablystock_added`). 저장된 값이 없으면 `status: null`, 나머지는 `None`/`0`. Task 4의 프론트가 이 응답을 그대로 `freshnessResult`에 넣는다.

- [ ] **Step 1: 핸들러 추가**

```python
    @router.get("/freshness-status")
    def wonbe_freshness_status(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            _init_wonbe_table(conn)
            keys = [
                "freshness_status",
                "freshness_checked_at",
                "freshness_latest_created_at",
                "freshness_checked_goods",
                "freshness_checked_pages",
                "freshness_ingodaegi_added",
                "freshness_ablystock_added",
                "last_sync_at",
            ]
            placeholders = ", ".join("?" for _ in keys)
            rows = conn.execute(
                f"SELECT key, value FROM wonbe_meta WHERE key IN ({placeholders})",
                keys,
            ).fetchall()
            meta = {r["key"]: r["value"] for r in rows}
        finally:
            conn.close()

        def _int_or_zero(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0

        return {
            "ok": True,
            "status": meta.get("freshness_status"),
            "latest_created_at": meta.get("freshness_latest_created_at") or None,
            "last_sync_at": meta.get("last_sync_at"),
            "checked_goods": _int_or_zero(meta.get("freshness_checked_goods")),
            "checked_pages": _int_or_zero(meta.get("freshness_checked_pages")),
            "checked_at": meta.get("freshness_checked_at"),
            "ingodaegi_added": _int_or_zero(meta.get("freshness_ingodaegi_added")),
            "ablystock_added": _int_or_zero(meta.get("freshness_ablystock_added")),
        }
```

- [ ] **Step 2: 문법 검사**

Run: `cd backend && python -m py_compile api/wonbe_routes.py`
Expected: 에러 없음

- [ ] **Step 3: 서버 재시작 후 curl로 확인**

```bash
TOKEN='<token>'
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/wonbe/freshness-status
```

Expected: Task 2 Step 3에서 받은 것과 동일한 값들(단 `checked_at`은 그때 저장된 시각 그대로)이 GET으로도 그대로 조회됨.

- [ ] **Step 4: 인증 없이 호출 시 401인지 확인**

```bash
curl -s -w "\n%{http_code}\n" http://127.0.0.1:8000/wonbe/freshness-status
```

Expected: 마지막 줄 `401`

- [ ] **Step 5: Commit**

```bash
git add backend/api/wonbe_routes.py
git commit -m "$(cat <<'EOF'
Add GET /wonbe/freshness-status to read persisted freshness-check result

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 대시보드가 마운트 시 저장된 상태를 불러오고 확장된 정보를 표시

**Files:**
- Modify: `src/components/Dashboard/Overview.jsx:359-365` (마운트 `useEffect`), `src/components/Dashboard/Overview.jsx:1421-1426` (freshness 정보 텍스트 렌더링)

**Interfaces:**
- Consumes: `GET /wonbe/freshness-status` (Task 3), 응답 필드 `status`, `latest_created_at`, `last_sync_at`, `checked_goods`, `checked_pages`, `checked_at`, `ingodaegi_added`, `ablystock_added`.

- [ ] **Step 1: 마운트 시 상태를 불러오는 함수 추가**

`Overview.jsx`에서 `handleFreshnessCheck` 함수(약 340번 줄) 바로 뒤에 추가:

```javascript
    const fetchFreshnessStatus = async () => {
        try {
            const res = await fetch(`${LOCAL_API_BASE}/wonbe/freshness-status`, {
                headers: authHeaders,
            });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok && data.status) {
                setFreshnessResult(data);
            }
        } catch {
            // 네트워크 오류 시 조용히 무시 — "아직 확인하지 않았습니다" 상태 유지
        }
    };
```

- [ ] **Step 2: 마운트 `useEffect`에서 호출**

기존 (359~365번 줄):

```javascript
    useEffect(() => {
        fetchUsers();
        fetchResolved();
        fetchTodos();
        fetchTodayTodos();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
```

다음으로 교체:

```javascript
    useEffect(() => {
        fetchUsers();
        fetchResolved();
        fetchTodos();
        fetchTodayTodos();
        fetchFreshnessStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
```

- [ ] **Step 3: 정보 텍스트에 확인 시각·추가 건수 표시 추가**

기존 (1421~1426번 줄):

```jsx
                            {freshnessResult && (
                                <span>
                                    에이블리 최신 등록일 {freshnessResult.latest_created_at || '-'} · 마지막 동기화 {freshnessResult.last_sync_at || '없음'}
                                    {' '}(상품 {freshnessResult.checked_goods}건 / {freshnessResult.checked_pages}페이지 확인)
                                </span>
                            )}
```

다음으로 교체:

```jsx
                            {freshnessResult && (
                                <span>
                                    에이블리 최신 등록일 {freshnessResult.latest_created_at || '-'} · 마지막 동기화 {freshnessResult.last_sync_at || '없음'}
                                    {' '}(상품 {freshnessResult.checked_goods}건 / {freshnessResult.checked_pages}페이지 확인)
                                    {freshnessResult.checked_at && (
                                        <>
                                            {' · 마지막 최신화 확인 '}{freshnessResult.checked_at}
                                            {' (입고대기 '}{freshnessResult.ingodaegi_added ?? 0}{'건 추가 · 에이블리재고변경 '}{freshnessResult.ablystock_added ?? 0}{'건 추가)'}
                                        </>
                                    )}
                                </span>
                            )}
```

- [ ] **Step 4: 프론트 개발 서버 실행 및 린트 확인**

Run: `npm run lint`
Expected: `Overview.jsx` 관련 에러 없음 (경고는 기존에 있던 것과 동일 수준이면 무방)

- [ ] **Step 5: 브라우저로 수동 확인**

`npm run dev` 실행 후 대시보드 접속:
1. 새로고침 직후 — 이전에 Task 2/3에서 저장된 값이 있다면 버튼을 누르지 않아도 파란불/빨간불과 "마지막 최신화 확인 ..." 텍스트가 바로 보이는지 확인.
2. "최신화 확인" 버튼 클릭 → 완료 후 시각과 추가 건수가 갱신되는지 확인.
3. 새로고침 → 방금 클릭한 결과가 그대로 다시 보이는지 확인(1번과 동일하게 재검증).

Expected: 세 확인 모두 통과.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard/Overview.jsx
git commit -m "$(cat <<'EOF'
Load persisted freshness status on dashboard mount and show check time

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
