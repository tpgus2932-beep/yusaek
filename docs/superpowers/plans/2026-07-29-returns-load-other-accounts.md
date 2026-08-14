# 반품 "불러오기" 모달에 계정 탭 추가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "불러오기" 모달에서 임시저장 기록이 있는 계정들을 탭으로 보여주고, 다른 계정의 스냅샷도 제한 없이 불러올 수 있게 한다.

**Architecture:** 백엔드에 계정 목록 엔드포인트를 추가하고 기존 `/returns/saves`에 `username` 쿼리 파라미터를, `/returns/load`의 id 조회에서 소유자 제한을 없앤다. 프론트는 모달에 탭 행을 추가해 계정 전환 시 목록을 다시 불러온다.

**Tech Stack:** FastAPI + SQLite/Turso(`_get_shared_db`), pytest, React.

## Global Constraints

- 계정 탭 라벨은 username 그대로 사용(display_name 조인 없음) — 스펙 비범위.
- 임시저장 기록이 있는 계정만 탭에 노출.
- 프론트엔드 자동화 테스트 없음(컨벤션) — lint + build로 검증.

참고 스펙: `docs/superpowers/specs/2026-07-29-returns-load-other-accounts-design.md`

---

### Task 1: 백엔드 — 계정 목록 엔드포인트 + 쿼리 파라미터 + 소유자 제한 제거

**Files:**
- Modify: `backend/api/returns_routes.py` (`/returns/saves` 근처에 신규 `/returns/saves-accounts` 추가, `/returns/saves`에 `username` 파라미터 추가, `/returns/load`의 id 분기에서 `AND username = ?` 제거)
- Modify: `backend/tests/test_returns_recent_snapshots.py` (교차 계정 테스트 갱신 + 신규 테스트 추가)

**Interfaces:**
- Produces: `GET /returns/saves-accounts` → `{"ok": true, "accounts": [{"username": str, "latest_updated_at": str}, ...]}` (최근 저장 기준 내림차순). `GET /returns/saves?username=X`(옵션) → 기존과 동일한 `{"ok", "items"}` 포맷이되 `X` 계정 기준.

- [ ] **Step 1: 기존 교차 계정 테스트를 새 기대값으로 고치고, 계정 목록 테스트를 추가**

`backend/tests/test_returns_recent_snapshots.py`의
`test_load_by_id_from_another_user_is_not_found` 함수를 통째로 아래로 교체:

```python
def test_load_by_id_from_another_user_succeeds():
    shared_db = _make_shared_db()
    client_a, state_a = _make_client(shared_db, username="alice")
    client_b, state_b = _make_client(shared_db, username="bob")

    state_a.queue_seller = [{"id": 1, "goods_name": "alice-item"}]
    client_a.post("/returns/save")
    saved_id = client_a.get("/returns/saves").json()["items"][0]["id"]

    state_b.queue_seller = []
    res = client_b.post("/returns/load", json={"id": saved_id})
    assert res.status_code == 200
    assert state_b.queue_seller == [{"id": 1, "goods_name": "alice-item"}]
```

파일 맨 끝에 추가:

```python


def test_saves_accounts_lists_only_accounts_with_snapshots_newest_first():
    shared_db = _make_shared_db()
    client_a, state_a = _make_client(shared_db, username="alice")
    client_b, state_b = _make_client(shared_db, username="bob")
    client_c, _state_c = _make_client(shared_db, username="carol")

    state_a.queue_seller = [{"id": 1}]
    client_a.post("/returns/save")
    state_b.queue_seller = [{"id": 2}]
    client_b.post("/returns/save")
    # carol never saves anything

    res = client_a.get("/returns/saves-accounts")
    assert res.status_code == 200
    usernames = [a["username"] for a in res.json()["accounts"]]
    assert usernames == ["bob", "alice"]


def test_saves_with_username_param_returns_that_accounts_items():
    shared_db = _make_shared_db()
    client_a, state_a = _make_client(shared_db, username="alice")
    client_b, state_b = _make_client(shared_db, username="bob")

    state_a.queue_seller = [{"id": 1, "goods_name": "alice-item"}]
    client_a.post("/returns/save")

    res = client_b.get("/returns/saves", params={"username": "alice"})
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_recent_snapshots.py -v`
Expected: `test_load_by_id_from_another_user_succeeds`는 아직 소유자 제한이
남아있어 404로 FAIL, `test_saves_accounts_lists_only_accounts_with_snapshots_newest_first`와
`test_saves_with_username_param_returns_that_accounts_items`는 라우트가 없어
404로 FAIL. 나머지 기존 테스트는 PASS.

- [ ] **Step 3: `/returns/saves`에 `username` 파라미터 추가 + `/returns/saves-accounts` 신설**

`backend/api/returns_routes.py`의 `@router.get("/returns/saves")` 블록:

```python
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

를 다음으로 교체:

```python
    @router.get("/returns/saves")
    def returns_saves(username: str | None = None, user: str = Depends(get_current_user)):
        target = username or user
        conn = get_db()
        rows = conn.execute(
            "SELECT id, updated_at FROM return_saved_snapshots WHERE username = ? ORDER BY id DESC LIMIT 3",
            (target,),
        ).fetchall()
        conn.close()
        return {"ok": True, "items": [{"id": r["id"], "updated_at": r["updated_at"]} for r in rows]}

    @router.get("/returns/saves-accounts")
    def returns_saves_accounts(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT username, MAX(updated_at) AS latest_updated_at
            FROM return_saved_snapshots
            GROUP BY username
            ORDER BY latest_updated_at DESC
            """
        ).fetchall()
        conn.close()
        return {
            "ok": True,
            "accounts": [
                {"username": r["username"], "latest_updated_at": r["latest_updated_at"]}
                for r in rows
            ],
        }
```

- [ ] **Step 4: `/returns/load`의 id 조회에서 소유자 제한 제거**

`backend/api/returns_routes.py`의 `/returns/load` 안:

```python
        if snapshot_id is not None:
            row = conn.execute(
                "SELECT payload, updated_at FROM return_saved_snapshots WHERE id = ? AND username = ?",
                (snapshot_id, user),
            ).fetchone()
```

를:

```python
        if snapshot_id is not None:
            row = conn.execute(
                "SELECT payload, updated_at FROM return_saved_snapshots WHERE id = ?",
                (snapshot_id,),
            ).fetchone()
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_recent_snapshots.py -v`
Expected: PASS (전체)

- [ ] **Step 6: 반품 관련 회귀 테스트 전체 확인**

Run: `cd backend && python -m pytest tests/ -k returns -v`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add backend/api/returns_routes.py backend/tests/test_returns_recent_snapshots.py
git commit -m "$(cat <<'EOF'
feat: allow loading return snapshots saved by other accounts

EOF
)"
```

---

### Task 2: 프론트엔드 — 모달에 계정 탭 추가

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx` (상태 선언부, `openLoadSnapshotModal`, 모달 JSX)

**Interfaces:**
- Consumes: Task 1의 `GET /returns/saves-accounts`, `GET /returns/saves?username=`.

- [ ] **Step 1: 상태 추가**

`loadSnapshotModalOpen`/`snapshotList`/`snapshotListLoading` 선언부 옆에 추가:

```javascript
    const [snapshotAccounts, setSnapshotAccounts] = useState([]);
    const [snapshotAccountsLoading, setSnapshotAccountsLoading] = useState(false);
    const [activeSnapshotAccount, setActiveSnapshotAccount] = useState('');
```

- [ ] **Step 2: `openLoadSnapshotModal`을 계정 목록까지 불러오도록 확장, 계정 전환 함수 추가**

기존 `openLoadSnapshotModal`:

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
```

를 아래로 교체(새 함수 `fetchSnapshotsForAccount`, `selectSnapshotAccount` 추가):

```javascript
    const fetchSnapshotsForAccount = async (username) => {
        setSnapshotListLoading(true);
        try {
            const res = await fetch(`${API}/returns/saves?username=${encodeURIComponent(username)}`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            setSnapshotList(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setSnapshotList([]);
        } finally {
            setSnapshotListLoading(false);
        }
    };

    const selectSnapshotAccount = (username) => {
        setActiveSnapshotAccount(username);
        fetchSnapshotsForAccount(username);
    };

    const openLoadSnapshotModal = async () => {
        setLoadSnapshotModalOpen(true);
        setSnapshotAccountsLoading(true);
        setSnapshotList([]);
        setActiveSnapshotAccount('');
        try {
            const res = await fetch(`${API}/returns/saves-accounts`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
            setSnapshotAccounts(accounts);
            if (accounts.length) {
                await selectSnapshotAccount(accounts[0].username);
            }
        } catch {
            setSnapshotAccounts([]);
        } finally {
            setSnapshotAccountsLoading(false);
        }
    };
```

- [ ] **Step 3: `closeLoadSnapshotModal`에서 계정 관련 상태도 초기화**

기존:

```javascript
    const closeLoadSnapshotModal = () => {
        setLoadSnapshotModalOpen(false);
        setSnapshotList([]);
    };
```

를:

```javascript
    const closeLoadSnapshotModal = () => {
        setLoadSnapshotModalOpen(false);
        setSnapshotList([]);
        setSnapshotAccounts([]);
        setActiveSnapshotAccount('');
    };
```

- [ ] **Step 4: 모달 JSX에 탭 행 추가**

모달 본문의 아래 부분(체크 시 `snapshotListLoading` 분기 바로 위):

```jsx
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {snapshotListLoading ? (
```

를:

```jsx
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {snapshotAccountsLoading ? (
                                <div>계정 목록 불러오는 중...</div>
                            ) : snapshotAccounts.length > 1 ? (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border-color, #e5e7eb)', paddingBottom: 8 }}>
                                    {snapshotAccounts.map((acc) => (
                                        <button
                                            key={acc.username}
                                            type="button"
                                            onClick={() => selectSnapshotAccount(acc.username)}
                                            style={{
                                                padding: '4px 10px',
                                                borderRadius: 999,
                                                border: '1px solid var(--border-color, #e5e7eb)',
                                                background: acc.username === activeSnapshotAccount ? 'var(--accent-color, #2563eb)' : 'transparent',
                                                color: acc.username === activeSnapshotAccount ? '#fff' : 'inherit',
                                                cursor: 'pointer',
                                                fontSize: '0.8rem',
                                            }}
                                        >
                                            {acc.username}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {snapshotListLoading ? (
```

(`snapshotAccounts.length > 1`인 경우에만 탭 행을 보여준다 — 계정이 1개뿐이면
탭이 무의미하므로 생략.)

- [ ] **Step 5: Lint + Build**

Run: `npm run lint`
Expected: `ReturnsPage.jsx` 관련 새 에러 없음

Run: `npx vite build --mode development`
Expected: 에러 없이 통과

- [ ] **Step 6: 커밋**

```bash
git add "src/components/Barcode/ReturnsPage.jsx"
git commit -m "$(cat <<'EOF'
feat: add account tabs to return snapshot load modal

EOF
)"
```

(리포지토리에 이 작업과 무관한 기존 미커밋 변경사항이 섞여 있을 수 있음 —
`git diff`로 내가 만든 hunk만 확인해 필요하면 `git apply --cached`로 골라
스테이징한다.)
