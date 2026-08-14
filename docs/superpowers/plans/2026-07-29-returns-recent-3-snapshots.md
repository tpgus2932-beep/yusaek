# 반품 임시저장 "불러오기"에서 최근 3개 중 선택 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 반품 스캔 페이지의 "임시저장"이 사용자당 1개를 덮어쓰던 것을 최근 3개까지 쌓이도록 바꾸고, "불러오기"를 누르면 그 중 하나를 골라 불러올 수 있게 한다.

**Architecture:** 백엔드에 새 테이블 `return_saved_snapshots`(사용자당 여러 행, 최신 3개만 유지)를 추가하고 `/returns/save`·`/returns/load`·`/returns/state`를 여기에 맞춰 바꾸며, 새 `/returns/saves` 목록 엔드포인트를 추가한다. 프론트엔드는 "불러오기" 클릭 시 목록 모달을 띄우고 항목 클릭으로 즉시 로드한다.

**Tech Stack:** FastAPI + SQLite/Turso 공유 DB(`_get_shared_db`), pytest + FastAPI TestClient(백엔드), React(프론트).

## Global Constraints

- 기존 `return_saved_states` 테이블/로직은 건드리지 않고 그대로 둔다(스펙 "비범위").
- 새 테이블도 `_get_shared_db()`를 사용해 Turso 호환을 유지한다.
- 최신 3개만 유지 — 저장할 때마다 오래된 것을 자동 삭제.
- 프론트엔드에는 자동화 테스트가 없음(레포 컨벤션) — `npm run lint` + `vite build`로 검증.

참고 스펙: `docs/superpowers/specs/2026-07-29-returns-recent-3-snapshots-design.md`

---

### Task 1: 백엔드 — snapshot 테이블 + save/load/state/list 엔드포인트

**Files:**
- Modify: `backend/main.py:975-990` (`_init_return_saved_states` 바로 아래에 `_init_return_saved_snapshots` 추가)
- Modify: `backend/api/returns_routes.py:494-556` (`/returns/state`, `/returns/save`, `/returns/load`)
- Modify: `backend/api/returns_routes.py` — `/returns/save` 뒤에 신규 `GET /returns/saves` 라우트 추가
- Test: `backend/tests/test_returns_recent_snapshots.py` (신규)

**Interfaces:**
- Consumes: 기존 `build_returns_router(...)` 시그니처(변경 없음), `ReturnState`, `_return_state_to_payload`, `_load_return_state_from_payload`, `_return_status`, `_return_queue_payload`, `_return_rows` (모두 `backend/services/returns_utils.py`, 시그니처 변경 없음).
- Produces: `GET /returns/saves` → `{"ok": true, "items": [{"id": int, "updated_at": str}, ...]}` (최신순 최대 3개). `POST /returns/load`는 이제 옵션 바디 `{"id": int}`를 받는다(없으면 최신 1개).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_returns_recent_snapshots.py` 생성:

```python
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.returns_routes import build_returns_router
from services.returns_utils import (
    ReturnState,
    _clean_invoice,
    _clean_product_name,
    _clean_qty,
    _load_return_state_from_payload,
    _lowercase_size_words,
    _normalize_key,
    _normalize_spaces,
    _option_slash_to_space,
    _read_return_excel,
    _reason_type,
    _return_queue_payload,
    _return_rows,
    _return_state_to_payload,
    _return_status,
)


class _NoCloseConn:
    """Wraps a real sqlite3 connection but swallows .close() calls.

    The router opens/closes a connection per call via get_db(); for an
    in-memory test double we reuse one connection so a real .close()
    wouldn't wipe data between calls within a test.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_shared_db():
    db_holder = {"conn": None}

    def _get_shared_db():
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE return_saved_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_shared_db()
    return _get_shared_db


def _make_client(get_shared_db, *, username="tester"):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: username,
            require_admin=lambda: username,
            get_return_state=_get_return_state,
            get_db=get_shared_db,
            get_setting=lambda key: None,
            return_status=_return_status,
            return_queue_payload=_return_queue_payload,
            return_rows=_return_rows,
            return_state_to_payload=_return_state_to_payload,
            load_return_state_from_payload=_load_return_state_from_payload,
            load_return_cost_base=lambda *a, **k: None,
            load_cost_base_df=lambda *a, **k: None,
            save_cost_base_df=lambda *a, **k: None,
            read_return_excel=_read_return_excel,
            clean_invoice=_clean_invoice,
            clean_product_name=_clean_product_name,
            lowercase_size_words=_lowercase_size_words,
            option_slash_to_space=_option_slash_to_space,
            clean_qty=_clean_qty,
            normalize_spaces=_normalize_spaces,
            reason_type=_reason_type,
            normalize_key=_normalize_key,
            content_disposition=lambda filename: f'attachment; filename="{filename}"',
            return_allowed_exts={".xlsx", ".xls"},
        )
    )
    return TestClient(app), state


def test_save_keeps_only_latest_three_snapshots():
    client, state = _make_client(_make_shared_db())
    for i in range(4):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        res = client.post("/returns/save")
        assert res.status_code == 200

    res = client.get("/returns/saves")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 3


def test_load_by_id_returns_that_snapshots_queue_seller():
    client, state = _make_client(_make_shared_db())
    for i in range(3):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        client.post("/returns/save")

    items = client.get("/returns/saves").json()["items"]
    oldest_id = items[-1]["id"]

    state.queue_seller = []
    res = client.post("/returns/load", json={"id": oldest_id})
    assert res.status_code == 200
    assert state.queue_seller == [{"id": 0, "goods_name": "item-0"}]


def test_load_without_id_returns_latest_snapshot():
    client, state = _make_client(_make_shared_db())
    for i in range(2):
        state.queue_seller = [{"id": i, "goods_name": f"item-{i}"}]
        client.post("/returns/save")

    state.queue_seller = []
    res = client.post("/returns/load", json={})
    assert res.status_code == 200
    assert state.queue_seller == [{"id": 1, "goods_name": "item-1"}]


def test_load_by_id_from_another_user_is_not_found():
    shared_db = _make_shared_db()
    client_a, state_a = _make_client(shared_db, username="alice")
    client_b, _state_b = _make_client(shared_db, username="bob")

    state_a.queue_seller = [{"id": 1, "goods_name": "alice-item"}]
    client_a.post("/returns/save")
    saved_id = client_a.get("/returns/saves").json()["items"][0]["id"]

    res = client_b.post("/returns/load", json={"id": saved_id})
    assert res.status_code == 404


def test_state_endpoint_reports_latest_saved_at():
    client, state = _make_client(_make_shared_db())
    res0 = client.get("/returns/state")
    assert res0.json()["saved_at"] is None

    save_res = client.post("/returns/save")
    saved_at = save_res.json()["saved_at"]

    res1 = client.get("/returns/state")
    assert res1.json()["saved_at"] == saved_at
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_recent_snapshots.py -v`
Expected: FAIL — `return_saved_snapshots` 테이블은 테스트가 직접 만들지만
`/returns/saves` 라우트가 아직 없어 404, `/returns/save`·`/returns/load`·
`/returns/state`는 여전히 `return_saved_states`를 참조해 SQL 에러 또는 잘못된
결과로 실패해야 한다.

- [ ] **Step 3: `backend/main.py`에 새 테이블 초기화 추가**

`backend/main.py:975-990` 현재:

```python
def _init_return_saved_states():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_saved_states (
            username TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_saved_states()
```

바로 아래에 추가:

```python
def _init_return_saved_snapshots():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_saved_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_saved_snapshots()
```

- [ ] **Step 4: `/returns/state`가 새 테이블을 보도록 수정**

`backend/api/returns_routes.py:494-513` 안의 아래 블록:

```python
    @router.get("/returns/state")
    def returns_state(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        conn = get_db()
        row = conn.execute(
            "SELECT updated_at FROM return_saved_states WHERE username = ?",
            (user,),
        ).fetchone()
        conn.close()
```

를 다음으로 교체(그 아래 `return {...}` 블록은 그대로 둠):

```python
    @router.get("/returns/state")
    def returns_state(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        conn = get_db()
        row = conn.execute(
            "SELECT updated_at FROM return_saved_snapshots WHERE username = ? ORDER BY id DESC LIMIT 1",
            (user,),
        ).fetchone()
        conn.close()
```

- [ ] **Step 5: `/returns/save`를 upsert에서 insert+prune으로 교체**

`backend/api/returns_routes.py:515-533`의 아래 블록 전체:

```python
    @router.post("/returns/save")
    def returns_save(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        payload = json.dumps(return_state_to_payload(state), ensure_ascii=False)
        updated_at = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        conn.execute(
            """
            INSERT INTO return_saved_states (username, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (user, payload, updated_at),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "saved_at": updated_at}
```

를 다음으로 교체:

```python
    @router.post("/returns/save")
    def returns_save(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        payload = json.dumps(return_state_to_payload(state), ensure_ascii=False)
        updated_at = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        conn.execute(
            "INSERT INTO return_saved_snapshots (username, payload, updated_at) VALUES (?, ?, ?)",
            (user, payload, updated_at),
        )
        conn.execute(
            """
            DELETE FROM return_saved_snapshots
            WHERE username = ? AND id NOT IN (
                SELECT id FROM return_saved_snapshots WHERE username = ? ORDER BY id DESC LIMIT 3
            )
            """,
            (user, user),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "saved_at": updated_at}

    @router.get("/returns/saves")
    def returns_saves(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT id, updated_at FROM return_saved_snapshots WHERE username = ? ORDER BY id DESC LIMIT 3",
            (user,),
        ).fetchall()
        conn.close()
        return {"ok": True, "items": [{"id": r["id"], "updated_at": r["updated_at"]} for r in rows]}
```

- [ ] **Step 6: `/returns/load`가 옵션 `id`를 받도록 수정**

`backend/api/returns_routes.py:535-556`의 아래 블록:

```python
    @router.post("/returns/load")
    def returns_load(user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT payload, updated_at FROM return_saved_states WHERE username = ?",
            (user,),
        ).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="임시저장된 반품 상태가 없습니다.")
        state = get_return_state(user)
        payload = json.loads(row["payload"])
        load_return_state_from_payload(state, payload)
```

를 다음으로 교체(그 아래 `return {...}` 블록은 그대로 둠, 단 지역변수명 충돌을 피하려고
파싱된 JSON 변수명을 `stored_payload`로 바꿈):

```python
    @router.post("/returns/load")
    def returns_load(payload: dict = Body(None), user: str = Depends(get_current_user)):
        snapshot_id = (payload or {}).get("id")
        conn = get_db()
        if snapshot_id is not None:
            row = conn.execute(
                "SELECT payload, updated_at FROM return_saved_snapshots WHERE id = ? AND username = ?",
                (snapshot_id, user),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT payload, updated_at FROM return_saved_snapshots WHERE username = ? ORDER BY id DESC LIMIT 1",
                (user,),
            ).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="임시저장된 반품 상태가 없습니다.")
        state = get_return_state(user)
        stored_payload = json.loads(row["payload"])
        load_return_state_from_payload(state, stored_payload)
```

(함수 파라미터 이름이 `payload`로 기존 바깥 스코프의 `row["payload"]` 접근과는
무관하므로 충돌 없음 — 단, 이후 줄에서 `json.loads(row["payload"])`의 결과를
담던 지역변수 `payload`는 파라미터명과 겹치므로 위와 같이 `stored_payload`로
반드시 바꿔야 한다.)

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_recent_snapshots.py -v`
Expected: PASS (5개 테스트 모두)

- [ ] **Step 8: 기존 반품 관련 백엔드 테스트 전체 회귀 확인**

Run: `cd backend && python -m pytest tests/ -k returns -v`
Expected: PASS (기존 테스트에 영향 없어야 함)

- [ ] **Step 9: 커밋**

```bash
git add backend/main.py backend/api/returns_routes.py backend/tests/test_returns_recent_snapshots.py
git commit -m "$(cat <<'EOF'
feat: keep last 3 return snapshots and add list/load-by-id endpoints

EOF
)"
```

---

### Task 2: 프론트엔드 — "불러오기" 버튼을 목록 모달로 교체

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx` (상태 선언부, `handleSaveSnapshot`/`handleLoadSnapshot` 인근, "불러오기" 버튼, 모달 JSX)

**Interfaces:**
- Consumes: Task 1에서 만든 `GET /returns/saves` (`{ok, items: [{id, updated_at}]}`), `POST /returns/load` (바디 `{id}`, 응답은 기존과 동일한 `{ok, saved_at, status, queues, onebe, last_type, scanned_count}`). 기존 `normalizeQueues`, `getAuthHeaders`, `API` 그대로 사용.
- Produces: 이후 다른 태스크 없음 — 페이지 내부에서만 쓰이는 상태/함수.

- [ ] **Step 1: 상태 추가**

`handleLoadSnapshot` 정의 바로 위(`backend` 아님, `src/components/Barcode/ReturnsPage.jsx`의
`handleSaveSnapshot` 선언부 앞)에 추가:

```javascript
    const [loadSnapshotModalOpen, setLoadSnapshotModalOpen] = useState(false);
    const [snapshotList, setSnapshotList] = useState([]);
    const [snapshotListLoading, setSnapshotListLoading] = useState(false);

    const formatSnapshotTime = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };
```

- [ ] **Step 2: `handleLoadSnapshot`을 모달용 함수 3개로 교체**

기존 `handleLoadSnapshot` 전체:

```javascript
    const handleLoadSnapshot = async () => {
        try {
            const res = await fetch(`${API}/returns/load`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '불러오기 실패');
            setStatus(data.status || null);
            setQueues(normalizeQueues(data.queues));
            setOnebeRows(data.onebe?.rows || []);
            setSavedAt(data.saved_at || '');
            setLastType(data.last_type || '-');
            lastTypeRef.current = data.last_type || '-';
            setMessage('임시저장된 반품 스캔 상태를 불러왔습니다.');
        } catch (err) {
            setMessage(err.message || '불러오기 실패');
        }
    };
```

를 다음으로 교체:

```javascript
    const openLoadSnapshotModal = async () => {
        setLoadSnapshotModalOpen(true);
        setSnapshotListLoading(true);
        try {
            const res = await fetch(`${API}/returns/saves`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            setSnapshotList(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setSnapshotList([]);
        } finally {
            setSnapshotListLoading(false);
        }
    };

    const closeLoadSnapshotModal = () => {
        setLoadSnapshotModalOpen(false);
        setSnapshotList([]);
    };

    const loadSnapshotById = async (id) => {
        try {
            const res = await fetch(`${API}/returns/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '불러오기 실패');
            setStatus(data.status || null);
            setQueues(normalizeQueues(data.queues));
            setOnebeRows(data.onebe?.rows || []);
            setSavedAt(data.saved_at || '');
            setLastType(data.last_type || '-');
            lastTypeRef.current = data.last_type || '-';
            setMessage('임시저장된 반품 스캔 상태를 불러왔습니다.');
            closeLoadSnapshotModal();
        } catch (err) {
            setMessage(err.message || '불러오기 실패');
        }
    };
```

- [ ] **Step 3: "불러오기" 버튼 onClick 교체**

`src/components/Barcode/ReturnsPage.jsx`의 아래 버튼:

```jsx
                        <button className={pageStyles.secondaryBtn} onClick={handleLoadSnapshot} disabled={loading}>
                            불러오기
                        </button>
```

를:

```jsx
                        <button className={pageStyles.secondaryBtn} onClick={openLoadSnapshotModal} disabled={loading}>
                            불러오기
                        </button>
```

- [ ] **Step 4: 목록 모달 JSX 추가**

기존 "일반사유로변경" 템플릿 선택 모달(`{reasonChangeModalOpen && ( ... )}` 블록) 바로
뒤에, 같은 오버레이 스타일을 재사용해 아래를 추가:

```jsx
            {loadSnapshotModalOpen && (
                <div
                    onClick={closeLoadSnapshotModal}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(360px, 90vw)',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>임시저장 불러오기</strong>
                            <button type="button" onClick={closeLoadSnapshotModal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {snapshotListLoading ? (
                                <div>목록 불러오는 중...</div>
                            ) : snapshotList.length === 0 ? (
                                <div>임시저장된 기록이 없습니다.</div>
                            ) : (
                                snapshotList.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={pageStyles.secondaryBtn}
                                        onClick={() => loadSnapshotById(item.id)}
                                    >
                                        {formatSnapshotTime(item.updated_at)}
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
```

`reasonChangeModalOpen` 블록을 찾으려면 `grep -n "reasonChangeModalOpen &&" src/components/Barcode/ReturnsPage.jsx`로
정확한 삽입 위치(그 블록을 닫는 `)}` 바로 다음 줄)를 확인한다.

- [ ] **Step 5: `handleLoadSnapshot` 참조가 남아있지 않은지 확인**

Run: `grep -n "handleLoadSnapshot" "src/components/Barcode/ReturnsPage.jsx"`
Expected: 출력 없음(0건)

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: `ReturnsPage.jsx` 관련 새 에러 없음(기존 무관 에러는 그대로일 수 있음)

- [ ] **Step 7: Build**

Run: `npx vite build --mode development`
Expected: 에러 없이 `modules transformed` 로 종료

- [ ] **Step 8: 커밋**

```bash
git add "src/components/Barcode/ReturnsPage.jsx"
git commit -m "$(cat <<'EOF'
feat: pick from last 3 return snapshots when loading

EOF
)"
```

(주의: 리포지토리에 이 작업과 무관한 기존 미커밋 변경사항이 많음 —
`src/components/Barcode/ReturnsPage.jsx` 한 파일만 명시적으로 add할 것,
`git add -A`/`git add .` 금지. 이 파일에 무관한 WIP가 섞여 있다면 `git diff`로
내가 만든 hunk만 확인해 `git apply --cached`로 골라 스테이징한다.)
