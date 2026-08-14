# 고객대기 "오회수" 처리 + 영구 저장 오회수 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 고객대기 탭에서 체크한 건들을 "오회수" 버튼으로 일괄 처리(이지어드민 회수신청 재등록 + "반품 오회수" 템플릿 이지데스크 문자)하고, 성공한 건은 DB에 영구 저장되는 신규 "오회수" 탭으로 옮겨서 "완료처리"할 때까지 계속 추적한다.

**Architecture:** 신규 라우터 `backend/api/return_regathering_routes.py` + 신규 공유 DB 테이블 `return_regathering`. 회수신청은 기존 `EzAdminClient.register_return_pickup`, 문자는 기존 `EzAdminClient.send_sms`(EzDesk)를 재사용. 성공한 항목은 기존 `_remove_return_queue_ids` 헬퍼로 인메모리 고객대기 큐에서 제거한다. 프론트엔드(`ReturnsPage.jsx`)는 고객대기 탭에 버튼 하나, 새 "오회수" 탭 하나를 추가한다.

**Tech Stack:** FastAPI (Python, `backend/api/return_regathering_routes.py`, `backend/main.py`), React (`src/components/Barcode/ReturnsPage.jsx`), pytest + respx (백엔드 테스트), 프론트엔드는 자동화 테스트 없음(수동 브라우저 확인 + `npm run lint`).

## Global Constraints

- "반품 오회수" 템플릿은 이미 만들어져 있다고 확인됨 — 템플릿 생성 UI는 만들지 않는다. 없으면 에러만 표시.
- 템플릿 문구는 변수치환 없이 원문 그대로 전송한다 (일반사유변경 템플릿 SMS 기능과 동일한 규칙).
- 회수신청 + 문자 **둘 다** 성공해야 고객대기 큐에서 제거하고 `return_regathering`에 저장한다. 하나라도 실패하면 고객대기에 그대로 남긴다.
- 이지데스크 세션 만료를 만나면 그 시점에서 나머지 항목 처리를 멈춘다 (이지어드민 세션 만료는 항상 처리 시작 전에 미리 확인해 전체를 막는다).
- `return_regathering` 테이블은 `_get_shared_db()`를 사용한다 (다른 반품 관련 영구 데이터와 동일).
- 오회수 탭은 목록 조회 + 완료처리(행 삭제)만 지원한다 — 메모/재시도 등 부가 기능 없음.

---

### Task 1: 백엔드 — `return_regathering` 테이블 + 신규 라우터

**Files:**
- Modify: `backend/main.py` (테이블 초기화 + 라우터 등록 추가)
- Create: `backend/api/return_regathering_routes.py`
- Test: `backend/tests/test_return_regathering_routes.py` (신규)

**Interfaces:**
- Consumes: `sdk.ezadmin.EzAdminClient.register_return_pickup(invoice_no) -> dict`(기존), `EzAdminClient.send_sms(receiver, sender, msg) -> dict`(기존), `EzAdminSessionExpired`/`EzDeskSessionExpired`(기존 예외), `sdk.config.EZDESK_SMS_SENDER`(기존 상수), `api.returns_routes._remove_return_queue_ids(state, remove_ids: set) -> None`(기존 모듈 레벨 헬퍼, import해서 재사용), `_get_shared_db()`/`_get_return_state()`/`_get_setting()`/`_return_queue_payload()`(main.py 기존 콜백들)
- Produces: `build_return_regathering_router(*, get_current_user, get_return_state, get_shared_db, get_setting, return_queue_payload)`. 엔드포인트 `GET /return-regathering/list`, `POST /return-regathering/execute`, `POST /return-regathering/{id}/complete`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_return_regathering_routes.py`를 새로 만든다:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.return_regathering_routes import build_return_regathering_router
from api.returns_routes import _remove_return_queue_ids
from services.returns_utils import ReturnState, _return_queue_payload


def _make_client(*, settings=None):
    settings = settings or {}
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    db_holder = {"conn": None}

    def _get_return_state(user):
        return state

    def _get_shared_db():
        import sqlite3
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute(
                "CREATE TABLE sms_templates (id TEXT, name TEXT, msg TEXT, title TEXT, msg_type TEXT, sort_order INTEGER)"
            )
            conn.execute(
                """CREATE TABLE return_regathering (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice TEXT NOT NULL, order_no TEXT NOT NULL DEFAULT '',
                    item_sno TEXT NOT NULL DEFAULT '', request_no TEXT NOT NULL DEFAULT '',
                    buyer_tel TEXT NOT NULL DEFAULT '', goods_name TEXT NOT NULL DEFAULT '',
                    option_raw TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL DEFAULT '',
                    requested_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        # 테스트 전용: 매 호출마다 같은 in-memory 커넥션을 반환해야 데이터가 유지됨
        return db_holder["conn"]

    app = FastAPI()
    app.include_router(
        build_return_regathering_router(
            get_current_user=lambda: "tester",
            get_return_state=_get_return_state,
            get_shared_db=_get_shared_db,
            get_setting=lambda key: settings.get(key),
            return_queue_payload=_return_queue_payload,
        )
    )
    return TestClient(app), state, db_holder


def _seed_template(db_holder, msg="오회수 안내: {상품명}"):
    db_holder["conn"].execute(
        "INSERT INTO sms_templates (id, name, msg, title, msg_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "반품 오회수", msg, "", "SMS", 0),
    )
    db_holder["conn"].commit()


def _customer_item(item_id):
    return {
        "id": item_id, "scan": f"scan{item_id}", "match": f"inv{item_id}",
        "item_sno": 100 + item_id, "request_no": str(200 + item_id),
        "buyer_tel": "010-1234-5678", "goods_name": "테스트 상품", "option_raw": "블랙/M",
        "order_no": str(300 + item_id),
    }


@respx.mock
def test_execute_moves_item_to_regathering_on_full_success():
    respx.post("https://ga80.ezadmin.co.kr/popup35.htm").mock(
        return_value=httpx.Response(200, text="batch_cs_abc123")
    )
    respx.post("https://ga80.ezadmin.co.kr/function.htm").mock(
        return_value=httpx.Response(200, json={"error": 0})
    )
    respx.post("https://ezdesk.ezadmin.co.kr/function.php").mock(
        return_value=httpx.Response(200, json={"error": 0})
    )

    client, state, db_holder = _make_client(
        settings={"ezadmin_phpsessid": "sess", "ezdesk_phpsessid": "esess"}
    )
    _seed_template(db_holder)
    item = _customer_item(1)
    state.queue_customer = [item]
    state.all_items = [item]

    res = client.post("/return-regathering/execute", json={"items": [item]})

    assert res.status_code == 200
    data = res.json()
    assert data["results"][0]["ok"] is True
    assert state.queue_customer == []

    rows = db_holder["conn"].execute("SELECT * FROM return_regathering").fetchall()
    assert len(rows) == 1
    assert rows[0]["invoice"] == "inv1"
    assert rows[0]["buyer_tel"] == "01012345678"


def test_execute_needs_ezadmin_session():
    client, state, db_holder = _make_client(settings={})
    item = _customer_item(1)
    res = client.post("/return-regathering/execute", json={"items": [item]})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert data["need_session"] is True


def test_execute_requires_template():
    client, state, db_holder = _make_client(settings={"ezadmin_phpsessid": "sess"})
    item = _customer_item(1)
    res = client.post("/return-regathering/execute", json={"items": [item]})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "템플릿" in data["detail"]


def test_complete_deletes_row():
    client, state, db_holder = _make_client(settings={"ezadmin_phpsessid": "sess"})
    _seed_template(db_holder)
    db_holder["conn"].execute(
        """INSERT INTO return_regathering
           (invoice, order_no, item_sno, request_no, buyer_tel, goods_name, option_raw, requested_by, requested_at)
           VALUES ('inv1','300','101','201','01012345678','상품','블랙/M','tester','2026-07-24T00:00:00')"""
    )
    db_holder["conn"].commit()
    row_id = db_holder["conn"].execute("SELECT id FROM return_regathering").fetchone()["id"]

    res = client.post(f"/return-regathering/{row_id}/complete")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    remaining = db_holder["conn"].execute("SELECT * FROM return_regathering").fetchall()
    assert remaining == []
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd backend && python -m pytest tests/test_return_regathering_routes.py -v`
Expected: `ModuleNotFoundError: No module named 'api.return_regathering_routes'`로 전부 FAIL (수집 단계)

- [ ] **Step 3: 신규 라우터 파일 작성**

`backend/api/return_regathering_routes.py`를 새로 만든다:

```python
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

try:
    from sdk import config
    from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk import config
    from backend.sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired

try:
    from api.returns_routes import _remove_return_queue_ids
except ModuleNotFoundError:
    from backend.api.returns_routes import _remove_return_queue_ids

_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_TEMPLATE_NAME = "반품 오회수"


def build_return_regathering_router(
    *,
    get_current_user,
    get_return_state,
    get_shared_db,
    get_setting,
    return_queue_payload,
):
    router = APIRouter(prefix="/return-regathering")

    def _clean_phone(raw: str) -> str:
        return "".join(ch for ch in str(raw or "") if ch.isdigit())

    @router.get("/list")
    def list_regathering(user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            rows = conn.execute(
                "SELECT * FROM return_regathering ORDER BY requested_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return {"items": [dict(r) for r in rows]}

    @router.post("/execute")
    async def execute_regathering(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        conn = get_shared_db()
        try:
            tmpl = conn.execute(
                "SELECT msg FROM sms_templates WHERE name = ?", (_TEMPLATE_NAME,)
            ).fetchone()
        finally:
            conn.close()
        if not tmpl or not tmpl["msg"]:
            raise HTTPException(
                status_code=400,
                detail=f'"{_TEMPLATE_NAME}" 템플릿을 찾을 수 없습니다. 사이드메뉴 문자 발송에서 만들어주세요.',
            )
        template_msg = tmpl["msg"]

        state = get_return_state(user)
        ez = EzAdminClient(get_setting)

        results = []
        moved_ids = set()
        session_expired = False
        for item in items:
            if session_expired:
                break
            item_id = item.get("id")
            result = {"id": item_id, "ok": False, "error": None}
            invoice = str(item.get("match") or "").strip()
            phone = _clean_phone(item.get("buyer_tel"))
            try:
                if not invoice:
                    raise ValueError("송장번호(invoice) 없음")
                await ez.register_return_pickup(invoice)

                if not phone:
                    raise ValueError("전화번호 없음")
                sms_result = await ez.send_sms(phone, config.EZDESK_SMS_SENDER, template_msg)
                if sms_result.get("error") not in (0, "0"):
                    raise RuntimeError(f"이지데스크 전송 실패: {sms_result}")

                conn = get_shared_db()
                try:
                    conn.execute(
                        """INSERT INTO return_regathering
                           (invoice, order_no, item_sno, request_no, buyer_tel, goods_name, option_raw, requested_by, requested_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            invoice,
                            str(item.get("order_no") or ""),
                            str(item.get("item_sno") or ""),
                            str(item.get("request_no") or ""),
                            phone,
                            str(item.get("goods_name") or ""),
                            str(item.get("option_raw") or ""),
                            user,
                            datetime.now(timezone.utc).isoformat(),
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

                result["ok"] = True
                moved_ids.add(item_id)
            except EzDeskSessionExpired:
                result["error"] = "이지데스크 세션 만료"
                session_expired = True
            except EzAdminSessionExpired as e:
                result["error"] = f"이지어드민 세션 만료: {e}"
            except Exception as e:
                result["error"] = str(e)[:200]
            results.append(result)

        if moved_ids:
            _remove_return_queue_ids(state, moved_ids)

        response = {"ok": True, "results": results, "queues": return_queue_payload(state)}
        if session_expired:
            response["need_ezdesk_session"] = True
        return response

    @router.post("/{regathering_id}/complete")
    def complete_regathering(regathering_id: int, user: str = Depends(get_current_user)):
        conn = get_shared_db()
        try:
            conn.execute("DELETE FROM return_regathering WHERE id = ?", (regathering_id,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
```

- [ ] **Step 4: 테스트 재실행 → 전체 통과 확인**

Run: `cd backend && python -m pytest tests/test_return_regathering_routes.py -v`
Expected: 4개 테스트 모두 PASS

- [ ] **Step 5: `main.py`에 테이블 초기화 + 라우터 등록 추가**

`backend/main.py`의 `_init_accident_invoices()`/`_ensure_accident_invoice_memo()`/
`build_accident_cargo_router(...)` 블록(1567~1612행 부근) 바로 뒤에 추가:

```python
from api.return_regathering_routes import build_return_regathering_router


def _init_return_regathering():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_regathering (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice TEXT NOT NULL,
            order_no TEXT NOT NULL DEFAULT '',
            item_sno TEXT NOT NULL DEFAULT '',
            request_no TEXT NOT NULL DEFAULT '',
            buyer_tel TEXT NOT NULL DEFAULT '',
            goods_name TEXT NOT NULL DEFAULT '',
            option_raw TEXT NOT NULL DEFAULT '',
            requested_by TEXT NOT NULL DEFAULT '',
            requested_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_regathering()

app.include_router(
    build_return_regathering_router(
        get_current_user=_get_current_user,
        get_return_state=_get_return_state,
        get_shared_db=_get_shared_db,
        get_setting=_get_setting,
        return_queue_payload=_return_queue_payload,
    )
)
```

(임포트 줄은 파일 상단의 다른 `from api.xxx_routes import build_xxx_router` 임포트들 옆에 옮겨 적어도 되지만, 최소 변경 원칙상 사용 지점 바로 위에 추가해도 무방 — 이 프로젝트 컨벤션상 각 라우터 임포트는 파일 최상단에 모여 있으므로, 실제로는 상단 임포트 블록에 추가하고 아래 위치엔 테이블 초기화+등록만 남긴다.)

- [ ] **Step 6: 회귀 확인**

Run: `cd backend && python -m pytest tests/ -q`
Expected: 기존 테스트 전부 PASS (신규 4개 포함 총 개수 증가), `python -c "import sys; sys.path.insert(0,'.'); import main"`로 앱이 정상 임포트되는지 확인 (신규 라우터 등록 문법 오류 없는지)

- [ ] **Step 7: 커밋**

```bash
git add backend/main.py backend/api/return_regathering_routes.py backend/tests/test_return_regathering_routes.py
git commit -m "feat: add return_regathering DB table and router for 오회수 flow"
```

---

### Task 2: 프론트엔드 — 고객대기 탭 "오회수" 버튼

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: Task 1의 `POST /return-regathering/execute`, 기존 `API`/`getAuthHeaders`/`setQueues`/`normalizeQueues`/`setMessage`/`selectedCustomer`
- Produces: 함수 `handleRegatherExecute(selectedItems)`, 상태 `regatherExecuteLoading`. Task 3에서 정의할 `fetchRegatherItems`를 이 핸들러 성공 시 호출한다 (Task 3에서 이 파일에 추가).

- [ ] **Step 1: 로딩 상태 추가**

`src/components/Barcode/ReturnsPage.jsx`에서 `const [kimsungilSendLoading, ...]` 선언 바로 뒤(현재 82행 부근)에 추가:

```jsx
    const [kimsungilSendLoading, setKimsungilSendLoading] = useState(false);
    const [regatherExecuteLoading, setRegatherExecuteLoading] = useState(false);
```

- [ ] **Step 2: 핸들러 추가**

`handleSendToKimsungil` 함수 끝(현재 711행 부근, closing `};`) 바로 뒤에 추가:

```jsx
    const handleRegatherExecute = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setRegatherExecuteLoading(true);
        setMessage('');
        try {
            const res = await fetch(`${API}/return-regathering/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.need_session) {
                openEzadminModal(() => handleRegatherExecute(selectedItems));
                return;
            }
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok) throw new Error(data?.detail || '오회수 처리 실패');
            const ok = (data.results || []).filter((r) => r.ok).length;
            let msg = `오회수 처리 완료: ${ok}/${data.results.length}건 성공`;
            if (data.need_ezdesk_session) msg += ' — 이지데스크 세션이 만료되어 중단했습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.';
            setMessage(msg);
            if (typeof fetchRegatherItems === 'function') fetchRegatherItems();
        } catch (err) {
            setMessage(err.message || '오회수 처리 실패');
        } finally {
            setRegatherExecuteLoading(false);
        }
    };
```

(`fetchRegatherItems`는 Task 3에서 이 파일 상단에 정의된다 — 함수 선언은 호이스팅되므로 Task 2 시점에는 아직 없어 참조 에러가 나지만, Task 3까지 끝나면 정상 동작한다. Task 2만 단독으로 커밋하면 `fetchRegatherItems is not defined`가 되므로, **Task 2와 Task 3은 반드시 같이 커밋한다** — 아래 Task 3 Step 5에서 한 번에 커밋.)

- [ ] **Step 3: 고객대기 탭 액션 버튼 행에 "오회수" 버튼 추가**

고객대기 탭의 "바코드 출력" 버튼(현재 1763~1774행) 바로 뒤에 추가:

```jsx
                                            <button
                                                type="button"
                                                className={pageStyles.primaryBtn}
                                                onClick={() => handleRegatherExecute(items.filter((i) => selectedCustomer.has(i.id)))}
                                                disabled={regatherExecuteLoading || selectedCustomer.size === 0}
                                            >
                                                {regatherExecuteLoading ? '처리 중...' : `오회수 (${selectedCustomer.size}건 선택)`}
                                            </button>
```

- [ ] **Step 4: (Task 3과 함께 커밋 — 아래 참조)**

이 태스크의 커밋은 Task 3의 Step 5에서 함께 진행한다.

---

### Task 3: 프론트엔드 — 신규 "오회수" 탭

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: `GET /return-regathering/list`(Task 1), `POST /return-regathering/{id}/complete`(Task 1), `API`/`getAuthHeaders`
- Produces: 상태 `regatherItems`, `regatherLoading`. 함수 `fetchRegatherItems()`(Task 2가 호출), `handleCompleteRegather(id)`. 탭 배열에 `['regather', '오회수']` 추가, 새 렌더 분기.

- [ ] **Step 1: 상태 + 조회/완료처리 함수 추가**

`handleRegatherExecute` 함수(Task 2) 바로 뒤에 추가:

```jsx
    const [regatherItems, setRegatherItems] = useState([]);
    const [regatherLoading, setRegatherLoading] = useState(false);

    const fetchRegatherItems = async () => {
        setRegatherLoading(true);
        try {
            const res = await fetch(`${API}/return-regathering/list`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            setRegatherItems(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setRegatherItems([]);
        } finally {
            setRegatherLoading(false);
        }
    };

    const handleCompleteRegather = async (id) => {
        try {
            const res = await fetch(`${API}/return-regathering/${id}/complete`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error('완료처리 실패');
            setRegatherItems((prev) => prev.filter((r) => r.id !== id));
        } catch (err) {
            setMessage(err.message || '완료처리 실패');
        }
    };
```

- [ ] **Step 2: 탭이 활성화될 때 목록 불러오기**

`useEffect(() => { refreshState(); ... }, [refreshState]);` 블록(현재 199~202행) 바로 뒤에 추가:

```jsx
    useEffect(() => {
        if (activeTab === 'regather') fetchRegatherItems();
    }, [activeTab]);
```

- [ ] **Step 3: 탭 버튼 배열에 "오회수" 추가**

탭 배열(현재 1644~1652행):

```jsx
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
                                ['exchange_seller', '교환판매자'],
                                ['exchange_customer', '교환고객'],
                                ['unmatched', '미매칭 대기'],
                                ['onebe', '원베양식(고객대기)'],
                            ].map(([key, label]) => (
```

을 아래로 교체 (`regather` 항목 추가):

```jsx
                            {[
                                ['all', '전체 대기'],
                                ['seller', '판매자 대기'],
                                ['customer', '고객 대기'],
                                ['exchange_seller', '교환판매자'],
                                ['exchange_customer', '교환고객'],
                                ['unmatched', '미매칭 대기'],
                                ['regather', '오회수'],
                                ['onebe', '원베양식(고객대기)'],
                            ].map(([key, label]) => (
```

- [ ] **Step 4: "오회수" 탭 렌더 분기 추가**

고객대기 탭의 렌더 블록이 끝나는 지점(현재 1867행, `})()}` 바로 뒤), `{activeTab === 'exchange_seller' && (` 바로 앞에 추가:

```jsx
                            {activeTab === 'regather' && (
                                <div className={pageStyles.tableWrap}>
                                    {regatherLoading ? (
                                        <div className={pageStyles.empty}>불러오는 중...</div>
                                    ) : regatherItems.length === 0 ? (
                                        <div className={pageStyles.empty}>오회수 처리된 건이 없습니다.</div>
                                    ) : (
                                        <table className={pageStyles.table}>
                                            <thead>
                                                <tr>
                                                    <th>송장번호</th>
                                                    <th>상품명</th>
                                                    <th>전화번호</th>
                                                    <th>신청일시</th>
                                                    <th>완료처리</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {regatherItems.map((r) => (
                                                    <tr key={r.id}>
                                                        <td>{r.invoice}</td>
                                                        <td>{r.goods_name}</td>
                                                        <td>{r.buyer_tel}</td>
                                                        <td>{r.requested_at}</td>
                                                        <td>
                                                            <button
                                                                type="button"
                                                                className={pageStyles.secondaryBtn}
                                                                onClick={() => handleCompleteRegather(r.id)}
                                                            >
                                                                완료처리
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            )}
```

- [ ] **Step 5: Lint 실행 → 커밋 (Task 2 + Task 3 함께)**

Run: `npm run lint`
Expected: 이 변경으로 인한 새 에러 없음 (기존 무관 에러는 그대로 있어도 됨)

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add 오회수 button on customer tab and persistent 오회수 tab"
```

---

### Task 4: 수동 브라우저 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 백엔드/프론트 개발 서버 실행 (아직 안 떠 있다면)**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000` / `npm run dev`

- [ ] **Step 2: 브라우저 확인**

`http://localhost:5173` → 반품 → 고객 대기 탭에서 실제 건 1개 이상 체크 →

1. "오회수 (N건 선택)" 버튼이 보이는지 확인.
2. 클릭 → 이지어드민에 회수신청이 다시 등록되는지, 고객에게 "반품 오회수" 템플릿 문자가 실제로 가는지 확인.
3. 성공한 건이 고객대기 탭에서 사라지는지 확인.
4. "오회수" 탭으로 이동해 방금 처리한 건이 목록에 뜨는지 확인 (송장번호/상품명/전화번호/신청일시).
5. "완료처리" 클릭 → 그 행만 사라지는지, 새로고침(F5) 후에도 처리 전 다른 오회수 항목들은 남아있는지(=DB 저장 확인) 체크.
6. 이지어드민/이지데스크 세션이 없는 상태에서 눌렀을 때 각각 적절한 안내가 뜨는지 확인.

- [ ] **Step 3: 문제 없으면 완료 보고**
