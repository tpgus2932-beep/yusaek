# 반품 특이사항 등록 + 스캔 시 알림 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 반품 페이지에서 원송장번호별 특이사항을 등록/조회/삭제할 수 있게 하고, 등록된 원송장번호가 바코드 스캔으로 들어오면 대기 테이블에 배지로 표시하고 다른 알림음을 재생한다.

**Architecture:** 새 공유 DB 테이블(`return_special_notes`) + 전용 FastAPI 라우터(CRUD)를 백엔드에 추가하고, 기존 `/returns/scan` 핸들러의 일반 반품(판매자/고객) 매칭 경로에서 원송장번호로 조회해 응답과 큐 아이템에 실어 보낸다. 프론트는 `ReturnsPage.jsx`에 관리 모달(버튼+입력+목록)과 스캔 시 사운드/배지 처리를 추가한다.

**Tech Stack:** FastAPI + SQLite/Turso(공유 DB), React (상태는 로컬 `useState`, 별도 상태관리 라이브러리 없음), pytest + respx(백엔드 테스트), 프론트엔드 자동 테스트 없음(수동 검증 + `npm run build`).

## Global Constraints

- 새 테이블/라우터는 `_get_shared_db()`를 사용한다 (다른 사용자와 공유되는 데이터 — `backend/CLAUDE.md`의 `_get_db()` vs `_get_shared_db()` 구분 참고).
- 원송장번호는 기존 `clean_invoice`(숫자만 남기는 정제 함수)로 정규화한 값을 키로 저장/조회한다 — `map_d_to_e`/`map_lotte`가 만드는 `e_val`과 동일한 정규화 규칙.
- 교환(exchange) 스캔 경로는 이번 기능 범위 밖이다 — 건드리지 않는다.
- 프론트 신규 UI는 기존 인라인 모달 스타일(`csDetailModal`/`smsComposeItem` 블록, `ReturnsPage.jsx`)과 `pageStyles.primaryBtn`/`secondaryBtn` 클래스를 그대로 재사용한다. 새 CSS 파일이나 컴포넌트 라이브러리를 추가하지 않는다.
- 알림음 파일 `public/sounds/특이사항.wav`는 이미 존재한다 (새로 만들 필요 없음).
- 스펙 문서: `docs/superpowers/specs/2026-07-30-return-special-notes-design.md`.

---

### Task 1: 특이사항 CRUD 백엔드 (테이블 + 라우터)

**Files:**
- Create: `backend/api/return_special_notes_routes.py`
- Modify: `backend/main.py` (import 추가, 테이블 초기화 함수 추가, 라우터 등록)
- Test: `backend/tests/test_return_special_notes_routes.py`

**Interfaces:**
- Produces: `build_return_special_notes_router(*, get_current_user, get_db, clean_invoice) -> APIRouter`
  - `GET /return-special-notes/list` → `{"items": [{"id": int, "invoiceNo": str, "note": str, "createdBy": str, "createdAt": str}, ...]}`
  - `POST /return-special-notes/add` body `{"invoice_no": str, "note": str}` → 성공 시 위와 동일한 shape의 최신 전체 목록. 실패(`invoice_no`/`note` 비어있음) 시 400.
  - `DELETE /return-special-notes/{note_id}` → `{"ok": true}`
  - DB 테이블 `return_special_notes(id, invoice_no UNIQUE, note, created_by, created_at)` — Task 2가 같은 테이블을 조회한다.

- [ ] **Step 1: 테스트 파일 작성 (실패하는 테스트)**

`backend/tests/test_return_special_notes_routes.py` 생성:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.return_special_notes_routes import build_return_special_notes_router
from services.returns_utils import _clean_invoice


class _NoCloseConn:
    """실제 sqlite3 커넥션을 감싸되 .close() 호출을 무시한다.

    라우터는 매 호출마다 get_db()로 커넥션을 새로 열고 닫는 프로덕션 방식을
    흉내내지만, 인메모리 DB 테스트 더블에서 진짜 close()를 하면 같은 테스트
    안에서 다음 호출 때 데이터가 사라진다.
    """

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_client():
    db_holder = {"conn": None}

    def _get_db():
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE return_special_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_no TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )"""
            )
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_db()  # 요청 전에 데이터를 미리 심을 수 있도록 미리 생성

    app = FastAPI()
    app.include_router(
        build_return_special_notes_router(
            get_current_user=lambda: "tester",
            get_db=_get_db,
            clean_invoice=_clean_invoice,
        )
    )
    return TestClient(app), db_holder


def test_add_creates_note_and_appears_in_list():
    client, db_holder = _make_client()

    res = client.post(
        "/return-special-notes/add",
        json={"invoice_no": "1234-567890abc", "note": "파손 이력 있음"},
    )

    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["invoiceNo"] == "1234567890"  # clean_invoice로 숫자만 남음
    assert items[0]["note"] == "파손 이력 있음"
    assert items[0]["createdBy"] == "tester"

    list_res = client.get("/return-special-notes/list")
    assert list_res.status_code == 200
    assert list_res.json()["items"][0]["invoiceNo"] == "1234567890"


def test_add_same_invoice_overwrites_existing_note():
    client, db_holder = _make_client()
    client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "A"})

    res = client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "B"})

    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["note"] == "B"


def test_add_rejects_empty_invoice_no():
    client, db_holder = _make_client()
    res = client.post("/return-special-notes/add", json={"invoice_no": "", "note": "메모"})
    assert res.status_code == 400


def test_add_rejects_empty_note():
    client, db_holder = _make_client()
    res = client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "   "})
    assert res.status_code == 400


def test_delete_removes_note():
    client, db_holder = _make_client()
    client.post("/return-special-notes/add", json={"invoice_no": "111", "note": "메모"})
    note_id = client.get("/return-special-notes/list").json()["items"][0]["id"]

    res = client.delete(f"/return-special-notes/{note_id}")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert client.get("/return-special-notes/list").json()["items"] == []
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_return_special_notes_routes.py -v`
Expected: `ModuleNotFoundError: No module named 'api.return_special_notes_routes'` (아직 라우터 파일이 없으므로 전부 실패/에러).

- [ ] **Step 3: 라우터 구현**

`backend/api/return_special_notes_routes.py` 생성:

```python
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException


def build_return_special_notes_router(*, get_current_user, get_db, clean_invoice):
    router = APIRouter(prefix="/return-special-notes")

    def _list_payload() -> dict:
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT * FROM return_special_notes ORDER BY created_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return {
            "items": [
                {
                    "id": r["id"],
                    "invoiceNo": r["invoice_no"],
                    "note": r["note"],
                    "createdBy": r["created_by"],
                    "createdAt": r["created_at"],
                }
                for r in rows
            ]
        }

    @router.get("/list")
    def list_special_notes(user: str = Depends(get_current_user)):
        return _list_payload()

    @router.post("/add")
    def add_special_note(payload: dict = Body(...), user: str = Depends(get_current_user)):
        invoice_no = clean_invoice(payload.get("invoice_no"))
        note = str(payload.get("note") or "").strip()
        if not invoice_no:
            raise HTTPException(status_code=400, detail="원송장번호를 입력하세요.")
        if not note:
            raise HTTPException(status_code=400, detail="특이사항 내용을 입력하세요.")

        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO return_special_notes (invoice_no, note, created_by, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(invoice_no) DO UPDATE SET
                    note = excluded.note,
                    created_by = excluded.created_by,
                    created_at = excluded.created_at
                """,
                (invoice_no, note, user, datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return _list_payload()

    @router.delete("/{note_id}")
    def delete_special_note(note_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM return_special_notes WHERE id = ?", (note_id,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_return_special_notes_routes.py -v`
Expected: 5개 테스트 모두 PASS

- [ ] **Step 5: `main.py`에 라우터 등록**

`backend/main.py:68` (`from api.return_processing_log_routes import build_return_processing_log_router` 바로 다음 줄)에 import 추가:

```python
from api.return_special_notes_routes import build_return_special_notes_router
```

`backend/main.py`에서 아래 블록(현재 1778~1785행, `_init_return_processing_log()` ~ 그 라우터 등록까지) 바로 다음에 새 블록을 추가:

```python
_init_return_processing_log()

app.include_router(
    build_return_processing_log_router(
        get_current_user=_get_current_user,
        get_shared_db=_get_shared_db,
    )
)


def _init_return_special_notes():
    conn = _get_shared_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS return_special_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no TEXT NOT NULL UNIQUE,
            note TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


_init_return_special_notes()

app.include_router(
    build_return_special_notes_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        clean_invoice=_clean_invoice,
    )
)

init_delivery_anomaly_tables(_get_shared_db)
```

(마지막 줄 `init_delivery_anomaly_tables(_get_shared_db)`는 기존 코드 그대로 — 새 블록이 그 앞에 끼워지는 것만 확인.)

- [ ] **Step 6: `main.py`가 정상적으로 import되는지 스모크 체크**

Run: `cd backend && python -c "import main"`
Expected: 에러 없이 조용히 종료 (테이블 생성 함수들이 모듈 로드 시점에 실행되므로, 문법/배선 오류가 있으면 여기서 즉시 드러남). `.env`가 없어 설정 관련 경고가 나더라도 `ImportError`/`SyntaxError`/`NameError`만 없으면 통과로 간주.

- [ ] **Step 7: 커밋**

```bash
git add backend/api/return_special_notes_routes.py backend/tests/test_return_special_notes_routes.py backend/main.py
git commit -m "feat: add return special notes CRUD API"
```

---

### Task 2: `/returns/scan`에 특이사항 매칭 연동

**Files:**
- Modify: `backend/api/returns_routes.py`
- Test: `backend/tests/test_returns_special_note_scan.py`

**Interfaces:**
- Consumes: Task 1의 `return_special_notes` 테이블(컬럼 `invoice_no`, `note`), `build_returns_router`가 이미 받는 `get_db`/`clean_invoice` 파라미터 (신규 파라미터 추가 없음 — 기존 것 재사용).
- Produces: `/returns/scan` 응답에 최상위 `"special_note": str`(매칭 없으면 `""`) 필드 추가. 일반 반품 매칭 경로로 큐에 들어가는 각 item(`state.queue_seller`/`state.queue_customer`/`state.queue_unmatched`에 들어가는 dict)에도 `"special_note": str` 필드가 붙는다. Task 4의 프론트가 이 두 값을 그대로 읽는다.

- [ ] **Step 1: 테스트 파일 작성 (실패하는 테스트)**

`backend/tests/test_returns_special_note_scan.py` 생성 — 기존 `test_returns_buyer_tel.py`의 스캔 셋업과 `test_return_regathering_routes.py`의 인메모리 공유 DB 패턴을 합친 것:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3

import pandas as pd
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
    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _make_shared_db_with_note(invoice_no=None, note=None):
    db_holder = {"conn": None}

    def _get_shared_db():
        if db_holder["conn"] is None:
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute(
                """CREATE TABLE return_special_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_no TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )"""
            )
            if invoice_no:
                conn.execute(
                    "INSERT INTO return_special_notes (invoice_no, note, created_by, created_at) VALUES (?, ?, 'tester', '2026-07-30T00:00:00')",
                    (invoice_no, note),
                )
            conn.commit()
            db_holder["conn"] = conn
        return _NoCloseConn(db_holder["conn"])

    _get_shared_db()
    return _get_shared_db


def _make_client(get_shared_db):
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
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


def _seed_scan_data(state, *, scanned_barcode, origin_invoice):
    state.map_d_to_e = {scanned_barcode: origin_invoice}
    state.df2 = pd.DataFrame([{
        "QTY": "1", "ITEM_TEXT": "테스트 상품", "REASON_TYPE": "판매자",
        "M_clean": origin_invoice, "DETAIL_REASON": "단순변심", "USER_COMMENT": "",
        "REQUEST_NO": "999", "ITEM_SNO": 111,
        "REFUND_HOLDER": "홍길동", "REFUND_ACCOUNT": "1234567890", "REFUND_BANK_SNO": 5,
        "BUYER_TEL": "010-1234-5678",
        "ORDER_NO": "555", "CANCEL_IMAGES": [], "OPTION_CODE": "", "GOODS_NAME": "테스트 상품", "OPTION_RAW": "블랙/m",
    }])
    state.df2_index = {origin_invoice: [0]}


def test_scan_matches_special_note_by_origin_invoice_not_scanned_barcode():
    get_shared_db = _make_shared_db_with_note("999000111", "파손 이력 있음")
    client, state = _make_client(get_shared_db)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    data = res.json()
    assert data["special_note"] == "파손 이력 있음"
    assert state.queue_seller[0]["special_note"] == "파손 이력 있음"


def test_scan_without_registered_note_returns_empty_special_note():
    get_shared_db = _make_shared_db_with_note()
    client, state = _make_client(get_shared_db)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    data = res.json()
    assert data["special_note"] == ""
    assert state.queue_seller[0]["special_note"] == ""


def test_scan_with_no_db_configured_does_not_crash():
    """get_db()가 None을 주는 기존 테스트들(get_db=lambda: None)이 계속 통과하는지 보장하는 회귀 테스트."""
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))

    def _get_return_state(user):
        return state

    app = FastAPI()
    app.include_router(
        build_returns_router(
            get_current_user=lambda: "tester",
            require_admin=lambda: "tester",
            get_return_state=_get_return_state,
            get_db=lambda: None,
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
    client = TestClient(app)
    _seed_scan_data(state, scanned_barcode="111", origin_invoice="999000111")

    res = client.post("/returns/scan", json={"barcode": "111"})

    assert res.status_code == 200
    assert res.json()["special_note"] == ""
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd backend && python -m pytest tests/test_returns_special_note_scan.py -v`
Expected: `KeyError: 'special_note'` (응답에 아직 그 필드가 없음) — 3개 테스트 모두 FAIL.

- [ ] **Step 3: 조회 헬퍼 추가**

`backend/api/returns_routes.py`에서 `_request_memo_for_item` 함수(현재 505~509행) 바로 다음에 추가:

```python
    def _lookup_special_note(invoice_no: str) -> str:
        invoice_no = clean_invoice(invoice_no)
        if not invoice_no:
            return ""
        conn = get_db()
        if conn is None:
            return ""
        try:
            row = conn.execute(
                "SELECT note FROM return_special_notes WHERE invoice_no = ?",
                (invoice_no,),
            ).fetchone()
        finally:
            conn.close()
        return row["note"] if row else ""
```

- [ ] **Step 4: `returns_scan` 핸들러에 배선**

`backend/api/returns_routes.py`의 `returns_scan` 함수에서, 아래 블록(현재 1652~1660행 부근):

```python
        e_val = state.map_d_to_e.get(barcode, "") or state.map_lotte.get(barcode, "")
        if not e_val:
            msg = f"[미매칭] 스캔:{barcode} → CJ(D)/롯데(G)에서 찾지 못함"
            state.queue_unmatched.append(
                {"id": state.next_id, "scan": barcode, "match": "", "item_text": msg, "qty": "", "type": "미매칭"}
            )
            state.next_id += 1
            state.last_type = "미매칭"
            return {"ok": True, "last_type": state.last_type, "queues": return_queue_payload(state)}
```

바로 다음 줄에 추가:

```python
        special_note = _lookup_special_note(e_val)
```

item 생성 루프(현재 1691~1711행 부근)에서:

```python
            item = {
                "id": state.next_id,
                "scan": barcode,
                "match": e_val,
                "item_text": item_text,
                "qty": qty,
                "type": rtype,
```

`"type": rtype,` 다음 줄에 추가:

```python
                "special_note": special_note,
```

함수 끝의 return 문(현재 1745~1750행):

```python
        return {
            "ok": True,
            "last_type": state.last_type,
            "queues": return_queue_payload(state),
            "related_unscanned": related_unscanned,
        }
```

`"last_type": state.last_type,` 다음 줄에 추가:

```python
            "special_note": special_note,
```

- [ ] **Step 5: 테스트 실행해서 통과 확인**

Run: `cd backend && python -m pytest tests/test_returns_special_note_scan.py -v`
Expected: 3개 테스트 모두 PASS

- [ ] **Step 6: 기존 반품 테스트 전체 회귀 확인**

Run: `cd backend && python -m pytest tests/test_returns_buyer_tel.py tests/test_returns_change_reason.py tests/test_returns_delete_items.py tests/test_returns_exchange_execute_selected.py tests/test_returns_onebe_ingo_matched.py tests/test_returns_recent_snapshots.py tests/test_returns_unmatched_lookup_cs.py -v`
Expected: 전부 PASS (이 파일들은 모두 `get_db=lambda: None` 또는 `return_special_notes` 테이블이 필요 없는 엔드포인트만 쓰므로, Step 3의 `conn is None` 가드 덕분에 영향 없어야 함).

- [ ] **Step 7: 커밋**

```bash
git add backend/api/returns_routes.py backend/tests/test_returns_special_note_scan.py
git commit -m "feat: match origin invoice against special notes on return scan"
```

---

### Task 3: 프론트엔드 — 특이사항 등록/조회/삭제 UI

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: Task 1의 `GET/POST /return-special-notes/list`, `/add`, `DELETE /return-special-notes/{id}` (응답 필드는 camelCase: `invoiceNo`, `note`, `createdBy`, `createdAt`, `id`).
- Produces: `specialNoteModalOpen`/`specialNoteList` 상태와 `openSpecialNoteModal` 핸들러 — Task 4는 건드리지 않음(독립적인 관심사).

- [ ] **Step 1: 상태 훅 추가**

`src/components/Barcode/ReturnsPage.jsx:97` (`const [regatherLoading, setRegatherLoading] = useState(false);` 바로 다음)에 추가:

```jsx
    const [specialNoteModalOpen, setSpecialNoteModalOpen] = useState(false);
    const [specialNoteList, setSpecialNoteList] = useState([]);
    const [specialNoteListLoading, setSpecialNoteListLoading] = useState(false);
    const [specialNoteInvoiceInput, setSpecialNoteInvoiceInput] = useState('');
    const [specialNoteTextInput, setSpecialNoteTextInput] = useState('');
    const [specialNoteSaving, setSpecialNoteSaving] = useState(false);
```

- [ ] **Step 2: 핸들러 추가**

`handleResetOnebe` 함수(현재 1422~1435행) 바로 다음에 추가:

```jsx
    const fetchSpecialNotes = async () => {
        setSpecialNoteListLoading(true);
        try {
            const res = await fetch(`${API}/return-special-notes/list`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ({}));
            setSpecialNoteList(Array.isArray(data?.items) ? data.items : []);
        } catch {
            setSpecialNoteList([]);
        } finally {
            setSpecialNoteListLoading(false);
        }
    };

    const openSpecialNoteModal = () => {
        setSpecialNoteModalOpen(true);
        fetchSpecialNotes();
    };

    const handleAddSpecialNote = async () => {
        const invoiceNo = specialNoteInvoiceInput.trim();
        const note = specialNoteTextInput.trim();
        if (!invoiceNo || !note) return;
        setSpecialNoteSaving(true);
        try {
            const res = await fetch(`${API}/return-special-notes/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ invoice_no: invoiceNo, note }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '특이사항 등록 실패');
            setSpecialNoteList(Array.isArray(data?.items) ? data.items : []);
            setSpecialNoteInvoiceInput('');
            setSpecialNoteTextInput('');
        } catch (err) {
            setMessage(err.message || '특이사항 등록 실패');
        } finally {
            setSpecialNoteSaving(false);
        }
    };

    const handleDeleteSpecialNote = async (id) => {
        try {
            const res = await fetch(`${API}/return-special-notes/${id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.detail || '삭제 실패');
            setSpecialNoteList((prev) => prev.filter((n) => n.id !== id));
        } catch (err) {
            setMessage(err.message || '삭제 실패');
        }
    };
```

- [ ] **Step 3: "초기화" 버튼 옆에 "특이사항" 버튼 추가**

`src/components/Barcode/ReturnsPage.jsx:1943~1945`:

```jsx
                        <button className={pageStyles.secondaryBtn} onClick={handleReset}>
                            초기화
                        </button>
```

바로 다음에 추가:

```jsx
                        <button type="button" className={pageStyles.secondaryBtn} onClick={openSpecialNoteModal}>
                            특이사항
                        </button>
```

- [ ] **Step 4: 모달 JSX 추가**

`csDetailModal` 모달 블록이 끝나는 지점(현재 2859행, `)}` 다음) 바로 뒤에 추가:

```jsx
            {specialNoteModalOpen && (
                <div
                    onClick={() => setSpecialNoteModalOpen(false)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
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
                            width: 'min(520px, 90vw)',
                            maxHeight: '80vh',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>반품 특이사항</strong>
                            <button type="button" onClick={() => setSpecialNoteModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                            <input
                                value={specialNoteInvoiceInput}
                                onChange={(e) => setSpecialNoteInvoiceInput(e.target.value)}
                                placeholder="원송장번호"
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6 }}
                            />
                            <textarea
                                value={specialNoteTextInput}
                                onChange={(e) => setSpecialNoteTextInput(e.target.value)}
                                placeholder="특이사항 내용을 입력하세요"
                                rows={3}
                                style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, resize: 'vertical', font: 'inherit' }}
                            />
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleAddSpecialNote}
                                disabled={specialNoteSaving || !specialNoteInvoiceInput.trim() || !specialNoteTextInput.trim()}
                            >
                                {specialNoteSaving ? '등록 중...' : '등록'}
                            </button>

                            <div style={{ borderTop: '1px solid var(--border-color, #e5e7eb)', paddingTop: 10, marginTop: 4 }}>
                                {specialNoteListLoading && <div>불러오는 중...</div>}
                                {!specialNoteListLoading && specialNoteList.length === 0 && (
                                    <div style={{ color: 'var(--text-secondary, #6b7280)' }}>등록된 특이사항이 없습니다.</div>
                                )}
                                {!specialNoteListLoading && specialNoteList.map((n) => (
                                    <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                                        <div>
                                            <div style={{ fontWeight: 600 }}>{n.invoiceNo}</div>
                                            <div style={{ whiteSpace: 'pre-wrap' }}>{n.note}</div>
                                            <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
                                                {n.createdBy} · {n.createdAt}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className={pageStyles.secondaryBtn}
                                            onClick={() => handleDeleteSpecialNote(n.id)}
                                        >
                                            삭제
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}
```

- [ ] **Step 5: 빌드 확인**

Run: `npm run build` (repo root)
Expected: 에러 없이 빌드 성공. (개발 서버를 직접 켜지 말 것 — 이미 떠 있는 서버가 있다면 사용자에게 브라우저에서 확인을 요청한다.)

- [ ] **Step 6: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: add return special notes management modal"
```

---

### Task 4: 프론트엔드 — 스캔 시 배지 + 알림음

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: Task 2가 `/returns/scan` 응답과 큐 아이템에 추가한 `special_note` 필드.

- [ ] **Step 1: 알림음 풀에 특이사항 사운드 추가**

`src/components/Barcode/ReturnsPage.jsx:256~267`:

```jsx
                soundsRef.current = {
                    seller: pool('/sounds/bb.wav'),
                    customer: pool('/sounds/zz.wav'),
                    unmatched: pool('/sounds/dd.wav'),
                    exchangeDefect: pool('/sounds/ww.wav'),
                    exchangeNormal: pool('/sounds/tt.wav'),
                    relatedNotice: pool('/sounds/ice.wav'),
                };
```

`relatedNotice: pool('/sounds/ice.wav'),` 다음 줄에 추가:

```jsx
                    specialNote: pool('/sounds/특이사항.wav'),
```

- [ ] **Step 2: `handleScan`에서 특이사항이면 다른 사운드 재생**

`src/components/Barcode/ReturnsPage.jsx:1155~1178`의 `handleScan` 함수 안, 현재:

```jsx
            const shouldPlay = nextType !== '-' && nextType !== '' && nextType !== '중복';
            if (shouldPlay) {
                playTypeSound(nextType, String(data.sound_type || ''));
            }
```

를 아래로 교체:

```jsx
            const shouldPlay = nextType !== '-' && nextType !== '' && nextType !== '중복';
            if (data.special_note) {
                playSound('specialNote');
            } else if (shouldPlay) {
                playTypeSound(nextType, String(data.sound_type || ''));
            }
```

- [ ] **Step 3: 대기 테이블에 특이사항 배지 컬럼 추가**

`src/components/Barcode/ReturnsPage.jsx:1657~1660` 부근:

```jsx
        const hasReason = items.some((item) => item.reason);
        const hasDetailReason = items.some((item) => item.detail_reason);
        const hasUserComment = items.some((item) => item.user_comment);
```

바로 다음 줄에 추가:

```jsx
        const hasSpecialNote = items.some((item) => item.special_note);
```

헤더 부분(`1684~1685` 부근):

```jsx
                            <th>분류</th>
                            {hasReason && <th>사유</th>}
```

를 아래로 교체:

```jsx
                            <th>분류</th>
                            {hasSpecialNote && <th>특이사항</th>}
                            {hasReason && <th>사유</th>}
```

셀 부분(`1724~1725` 부근):

```jsx
                                <td>{item.type}</td>
                                {hasReason && <td>{item.reason || ''}</td>}
```

를 아래로 교체:

```jsx
                                <td>{item.type}</td>
                                {hasSpecialNote && (
                                    <td style={{ color: '#dc2626', fontWeight: 600 }}>
                                        {item.special_note ? `⚠ ${item.special_note}` : ''}
                                    </td>
                                )}
                                {hasReason && <td>{item.reason || ''}</td>}
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build` (repo root)
Expected: 에러 없이 빌드 성공.

- [ ] **Step 5: 수동 검증 안내**

이미 개발 서버가 떠 있다면(직접 켜지 말 것), 사용자에게 다음을 확인해 달라고 안내:
1. 반품 페이지 → "특이사항" 버튼 → 임의의 원송장번호로 메모 등록.
2. CJ/롯데 + 에이블리 반품 데이터를 불러온 상태에서, 등록한 원송장번호에 해당하는 실제 반품 송장을 스캔.
3. 대기 테이블 해당 행에 빨간 "⚠ 메모내용" 배지가 뜨는지, `특이사항.wav` 소리가 나는지 확인.
4. 특이사항 모달에서 해당 메모를 삭제한 뒤 다시 스캔(또는 새로고침 후 확인)해서 배지가 더 이상 안 뜨는지 확인.

- [ ] **Step 6: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: alert and badge return scans matching a special note"
```
