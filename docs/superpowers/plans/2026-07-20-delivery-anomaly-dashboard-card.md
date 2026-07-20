# 택배 이상현상 대시보드 카드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매일 오후 4시 이후 첫 대시보드 접속 시 에이블리+llogis를 조회해 "발송 2일 이상 경과 + (송장 못찾음 또는 최종스캔 3일 이상 경과)" 조건에 걸린 송장을 자동으로 찾아, 공동 할 일/보낸 요청 카드 위에 "택배 이상현상" 카드로 보여주고 댓글을 달 수 있게 한다.

**Architecture:** 순수 판정 로직(날짜 파싱 + 조건 평가) → DB diff/동기화 로직 → FastAPI 라우터(목록/댓글/실행) → `main.py`에만 등록(로컬 전용) → 프론트 대시보드 카드가 마운트 시 목록을 그리고, KST 16시 이후면 실행을 트리거. "확인완료" 버튼 없이 매일 재계산 결과가 곧 진실이며, 스스로 해결된 항목은 자동으로 카드에서 사라진다.

**Tech Stack:** FastAPI (Python), sqlite3, httpx, pytest (백엔드) / React, lucide-react (프론트엔드)

**참고 문서:** `docs/superpowers/specs/2026-07-20-delivery-anomaly-dashboard-card-design.md`

## Global Constraints

- 조건은 누적 조건: `(오늘 - 발송일) >= 2일` 이면서 (`llogis에서 송장을 찾을 수 없음` 또는 `(오늘 - 최종스캔일) >= 3일` 또는 최종스캔일 자체가 없음)
- "확인완료" 버튼 없음 — 매일 재계산 시 조건에서 벗어난 항목은 자동 삭제(댓글도 함께 삭제), 계속 해당하는 항목은 유지(댓글 보존)
- 화면 표시 컬럼은 `src/components/Test/DeliveryStatusTest.jsx` 테이블과 동일: 주문번호/상품명/옵션/전화번호/발송일/송장번호/배송상태/위치/최종스캔일 (별도 "사유" 컬럼 없음)
- 스케줄링은 서버 cron 없이, 대시보드를 여는 브라우저가 KST 16시 이후 최초 1회 트리거 (서버가 하루 1회 가드)
- 신규 라우터는 `main.py`에만 등록 (로컬 전용 API, `collab_app.py`에는 등록하지 않음), `_get_shared_db()` 사용
- 백엔드 테스트는 `cd backend && python -m pytest tests/ -v`로 실행

---

## File Plan

- Create: `backend/services/delivery_anomaly_logic.py` — 순수 날짜 파싱 + 조건 판정 함수 (네트워크/DB 없음)
- Create: `backend/tests/test_delivery_anomaly_logic.py`
- Create: `backend/services/delivery_anomaly_store.py` — 테이블 생성 + diff/동기화 함수 (DB만, 네트워크 없음)
- Create: `backend/tests/test_delivery_anomaly_store.py`
- Create: `backend/api/delivery_anomaly_routes.py` — FastAPI 라우터 (list/comments는 Task 3, run은 Task 4에서 추가)
- Create: `backend/tests/test_delivery_anomaly_routes.py`
- Modify: `backend/main.py` — import + 테이블 초기화 + 라우터 등록
- Create: `src/components/Dashboard/DeliveryAnomalyCard.jsx`
- Modify: `src/components/Dashboard/Dashboard.module.css` — `.anomalyList` 등 신규 클래스 추가
- Modify: `src/components/Dashboard/Overview.jsx` — import + `resolvedGrid` 위에 삽입

---

### Task 1: 이상현상 판정 순수 로직

**Files:**
- Create: `backend/services/delivery_anomaly_logic.py`
- Test: `backend/tests/test_delivery_anomaly_logic.py`

**Interfaces:**
- Produces: `parse_ably_sent_date(raw: str | None) -> date | None`, `parse_llogis_scan_date(raw: str | None) -> date | None`, `is_invoice_missing(llogis_raw: dict) -> bool`, `latest_scan_date(llogis_raw: dict) -> date | None`, `evaluate_anomaly(sent_date: date | None, today: date, llogis_raw: dict) -> str | None` — Task 4가 이 시그니처 그대로 사용

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_delivery_anomaly_logic.py` 생성:

```python
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.delivery_anomaly_logic import (
    evaluate_anomaly,
    is_invoice_missing,
    latest_scan_date,
    parse_ably_sent_date,
    parse_llogis_scan_date,
)


def test_parse_ably_sent_date_iso_with_timezone():
    assert parse_ably_sent_date("2026-07-18T10:23:45+09:00") == date(2026, 7, 18)


def test_parse_ably_sent_date_space_separated():
    assert parse_ably_sent_date("2026-07-18 10:23:45") == date(2026, 7, 18)


def test_parse_ably_sent_date_none_or_empty():
    assert parse_ably_sent_date(None) is None
    assert parse_ably_sent_date("") is None


def test_parse_ably_sent_date_garbage_returns_none():
    assert parse_ably_sent_date("not-a-date") is None


def test_parse_llogis_scan_date_valid():
    assert parse_llogis_scan_date("20260718") == date(2026, 7, 18)


def test_parse_llogis_scan_date_invalid_length():
    assert parse_llogis_scan_date("2026718") is None
    assert parse_llogis_scan_date(None) is None


def test_is_invoice_missing_true_when_no_inv_info():
    assert is_invoice_missing({"invInfoList": [], "mvmList": []}) is True
    assert is_invoice_missing({}) is True


def test_is_invoice_missing_false_when_inv_info_present():
    assert is_invoice_missing({"invInfoList": [{"a": 1}]}) is False


def test_latest_scan_date_uses_last_movement():
    llogis_raw = {"mvmList": [{"rgstYmd": "20260710"}, {"rgstYmd": "20260715"}]}
    assert latest_scan_date(llogis_raw) == date(2026, 7, 15)


def test_latest_scan_date_none_when_no_movement():
    assert latest_scan_date({"mvmList": []}) is None


def test_evaluate_anomaly_not_yet_two_days_old():
    sent = date(2026, 7, 19)
    today = date(2026, 7, 20)
    assert evaluate_anomaly(sent, today, {"invInfoList": []}) is None


def test_evaluate_anomaly_sent_exactly_two_days_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [], "mvmList": []}
    assert evaluate_anomaly(sent, today, llogis_raw) == "llogis에서 송장을 찾을 수 없음"


def test_evaluate_anomaly_invoice_missing_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음"


def test_evaluate_anomaly_old_stuck_invoice_still_flagged():
    # 발송 5일 지난 것도 (2일 이상 누적 조건) 계속 잡혀야 함
    sent = date(2026, 7, 15)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음"


def test_evaluate_anomaly_scan_exactly_three_days_flagged():
    sent = date(2026, 7, 17)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260717", "paclStatNm": "간선상차"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) == "최종스캔 3일 이상 경과"


def test_evaluate_anomaly_scan_two_days_not_flagged():
    sent = date(2026, 7, 17)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260718", "paclStatNm": "간선상차"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_recent_scan_not_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260719", "paclStatNm": "배송완료"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_no_movement_history_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [{"a": 1}], "mvmList": []}
    reason = evaluate_anomaly(sent, today, llogis_raw)
    assert reason == "최종스캔 3일 이상 경과"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_logic.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.delivery_anomaly_logic'`

- [ ] **Step 3: 최소 구현 작성**

`backend/services/delivery_anomaly_logic.py` 생성:

```python
from __future__ import annotations

import re
from datetime import date


def parse_ably_sent_date(raw: str | None) -> date | None:
    """에이블리 발송일('2026-07-18T10:23:45+09:00' 또는 '2026-07-18 10:23:45' 등)을 date로 변환."""
    if not raw:
        return None
    text = str(raw).strip()
    if len(text) < 10:
        return None
    try:
        return date(int(text[0:4]), int(text[5:7]), int(text[8:10]))
    except (ValueError, IndexError):
        return None


def parse_llogis_scan_date(raw: str | None) -> date | None:
    """llogis 최종스캔일('20260718' 등)을 date로 변환."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) != 8:
        return None
    try:
        return date(int(digits[0:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        return None


def is_invoice_missing(llogis_raw: dict) -> bool:
    """llogis 응답에 invInfoList가 없으면 송장 자체를 찾을 수 없는 것."""
    return not (llogis_raw.get("invInfoList") or [])


def latest_scan_date(llogis_raw: dict) -> date | None:
    mvm_list = llogis_raw.get("mvmList") or []
    if not mvm_list:
        return None
    return parse_llogis_scan_date(mvm_list[-1].get("rgstYmd"))


def evaluate_anomaly(sent_date: date | None, today: date, llogis_raw: dict) -> str | None:
    """이상현상이면 사유 문자열, 아니면 None.

    조건: 발송일이 오늘로부터 2일 이상 지났으면서
      - llogis에서 송장을 찾을 수 없거나 (invInfoList 없음)
      - 최종스캔일이 없거나 오늘로부터 3일 이상 지난 경우
    """
    if sent_date is None:
        return None
    if (today - sent_date).days < 2:
        return None
    if is_invoice_missing(llogis_raw):
        return "llogis에서 송장을 찾을 수 없음"
    scan_date = latest_scan_date(llogis_raw)
    if scan_date is None or (today - scan_date).days >= 3:
        return "최종스캔 3일 이상 경과"
    return None
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_logic.py -v`
Expected: PASS (18개 테스트 모두 통과)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/delivery_anomaly_logic.py backend/tests/test_delivery_anomaly_logic.py
git commit -m "feat: add delivery anomaly detection pure logic"
```

---

### Task 2: 이상현상 DB 테이블 + diff/동기화 로직

**Files:**
- Create: `backend/services/delivery_anomaly_store.py`
- Test: `backend/tests/test_delivery_anomaly_store.py`

**Interfaces:**
- Consumes: 없음 (Task 1과 독립)
- Produces: `init_delivery_anomaly_tables(get_db: Callable[[], Connection]) -> None`, `sync_anomalies(conn: Connection, computed: dict[str, dict]) -> None` — Task 3/4가 그대로 사용. `computed`의 각 값은 `order_no, product_name, option_info, phone, sent_date, status, location, scan_date, reason` 키를 가진 dict.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_delivery_anomaly_store.py` 생성:

```python
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.delivery_anomaly_store import init_delivery_anomaly_tables, sync_anomalies


def _make_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn


def _sample(invoice_no):
    return {
        "order_no": f"order-{invoice_no}",
        "product_name": "상품",
        "option_info": "옵션",
        "phone": "01000000000",
        "sent_date": "2026-07-18",
        "status": "-",
        "location": "-",
        "scan_date": "-",
        "reason": "llogis에서 송장을 찾을 수 없음",
    }


def test_init_creates_tables():
    conn = _make_conn()
    init_delivery_anomaly_tables(lambda: conn)
    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert "delivery_anomalies" in tables
    assert "delivery_anomaly_comments" in tables


def test_sync_inserts_new_anomalies():
    conn = _make_conn()
    init_delivery_anomaly_tables(lambda: conn)
    sync_anomalies(conn, {"111": _sample("111"), "222": _sample("222")})
    rows = conn.execute("SELECT invoice_no FROM delivery_anomalies ORDER BY invoice_no").fetchall()
    assert [r["invoice_no"] for r in rows] == ["111", "222"]


def test_sync_removes_resolved_and_keeps_still_open():
    conn = _make_conn()
    init_delivery_anomaly_tables(lambda: conn)
    sync_anomalies(conn, {"111": _sample("111"), "222": _sample("222")})

    # 다음 실행: 111은 해결되어 사라지고 222는 여전히 이상현상, 333은 신규
    sync_anomalies(conn, {"222": _sample("222"), "333": _sample("333")})

    rows = conn.execute("SELECT invoice_no FROM delivery_anomalies ORDER BY invoice_no").fetchall()
    assert [r["invoice_no"] for r in rows] == ["222", "333"]


def test_sync_deletes_comments_of_resolved_anomaly():
    conn = _make_conn()
    init_delivery_anomaly_tables(lambda: conn)
    sync_anomalies(conn, {"111": _sample("111")})
    anomaly_id = conn.execute(
        "SELECT id FROM delivery_anomalies WHERE invoice_no = ?", ("111",)
    ).fetchone()["id"]
    conn.execute(
        "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
        (anomaly_id, "tester", "확인 중", "2026-07-18T00:00:00"),
    )
    conn.commit()

    sync_anomalies(conn, {})  # 111도 해결됨

    remaining_comments = conn.execute("SELECT * FROM delivery_anomaly_comments").fetchall()
    assert remaining_comments == []


def test_sync_preserves_comments_when_still_open():
    conn = _make_conn()
    init_delivery_anomaly_tables(lambda: conn)
    sync_anomalies(conn, {"111": _sample("111")})
    anomaly_id = conn.execute(
        "SELECT id FROM delivery_anomalies WHERE invoice_no = ?", ("111",)
    ).fetchone()["id"]
    conn.execute(
        "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
        (anomaly_id, "tester", "확인 중", "2026-07-18T00:00:00"),
    )
    conn.commit()

    sync_anomalies(conn, {"111": _sample("111")})  # 계속 열려있음

    remaining_comments = conn.execute("SELECT * FROM delivery_anomaly_comments").fetchall()
    assert len(remaining_comments) == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.delivery_anomaly_store'`

- [ ] **Step 3: 최소 구현 작성**

`backend/services/delivery_anomaly_store.py` 생성:

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))


def init_delivery_anomaly_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS delivery_anomalies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_no TEXT NOT NULL UNIQUE,
            order_no TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            option_info TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            sent_date TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            scan_date TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            detected_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS delivery_anomaly_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            anomaly_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def sync_anomalies(conn, computed: dict[str, dict]) -> None:
    """오늘 계산된 이상현상 집합(computed)에 맞춰 delivery_anomalies를 갱신.

    computed에 없는 기존 행은 삭제(댓글도 함께 삭제)하고,
    computed에만 있는 신규 항목은 추가한다. 계속 남아있는 항목은 건드리지 않는다
    (댓글 보존을 위해).
    """
    existing_rows = conn.execute("SELECT id, invoice_no FROM delivery_anomalies").fetchall()
    existing_by_invoice = {row["invoice_no"]: row["id"] for row in existing_rows}

    stale_invoices = set(existing_by_invoice) - set(computed)
    for inv in stale_invoices:
        anomaly_id = existing_by_invoice[inv]
        conn.execute("DELETE FROM delivery_anomaly_comments WHERE anomaly_id = ?", (anomaly_id,))
        conn.execute("DELETE FROM delivery_anomalies WHERE id = ?", (anomaly_id,))

    new_invoices = set(computed) - set(existing_by_invoice)
    detected_at = datetime.now(_KST).isoformat()
    for inv in new_invoices:
        data = computed[inv]
        conn.execute(
            """
            INSERT INTO delivery_anomalies
                (invoice_no, order_no, product_name, option_info, phone,
                 sent_date, status, location, scan_date, reason, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                inv,
                data.get("order_no", ""),
                data.get("product_name", ""),
                data.get("option_info", ""),
                data.get("phone", ""),
                data.get("sent_date", ""),
                data.get("status", ""),
                data.get("location", ""),
                data.get("scan_date", ""),
                data.get("reason", ""),
                detected_at,
            ),
        )

    conn.commit()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_store.py -v`
Expected: PASS (5개 테스트 모두 통과)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/delivery_anomaly_store.py backend/tests/test_delivery_anomaly_store.py
git commit -m "feat: add delivery anomaly DB sync logic"
```

---

### Task 3: FastAPI 라우터 — 목록/댓글 엔드포인트

**Files:**
- Create: `backend/api/delivery_anomaly_routes.py`
- Test: `backend/tests/test_delivery_anomaly_routes.py`

**Interfaces:**
- Consumes: `sync_anomalies`, `init_delivery_anomaly_tables` from Task 2 (`services.delivery_anomaly_store`)
- Produces: `build_delivery_anomaly_router(*, get_current_user, get_db, get_setting, set_setting) -> APIRouter` (Task 4가 같은 라우터에 `/run` 추가), 엔드포인트 `GET /delivery-anomaly/list`, `GET /delivery-anomaly/{id}/comments`, `POST /delivery-anomaly/{id}/comments`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_delivery_anomaly_routes.py` 생성:

```python
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.delivery_anomaly_routes import build_delivery_anomaly_router
from services.delivery_anomaly_store import init_delivery_anomaly_tables, sync_anomalies


def _make_client():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_delivery_anomaly_tables(lambda: conn)

    app = FastAPI()
    app.include_router(
        build_delivery_anomaly_router(
            get_current_user=lambda: "tester",
            get_db=lambda: conn,
            get_setting=lambda key: None,
            set_setting=lambda key, value: None,
        )
    )
    return TestClient(app), conn


def _sample():
    return {
        "order_no": "o1", "product_name": "상품A", "option_info": "M",
        "phone": "01011112222", "sent_date": "2026-07-18", "status": "-",
        "location": "-", "scan_date": "-", "reason": "llogis에서 송장을 찾을 수 없음",
    }


def test_list_empty_initially():
    client, _conn = _make_client()
    res = client.get("/delivery-anomaly/list")
    assert res.status_code == 200
    assert res.json() == {"items": []}


def test_list_returns_synced_anomaly():
    client, conn = _make_client()
    sync_anomalies(conn, {"999": _sample()})
    res = client.get("/delivery-anomaly/list")
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["invoiceNo"] == "999"
    assert items[0]["commentCount"] == 0


def test_add_and_list_comment():
    client, conn = _make_client()
    sync_anomalies(conn, {"999": _sample()})
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]

    res = client.post(f"/delivery-anomaly/{anomaly_id}/comments", json={"text": "확인 중입니다"})
    assert res.status_code == 200

    comments = client.get(f"/delivery-anomaly/{anomaly_id}/comments").json()["items"]
    assert len(comments) == 1
    assert comments[0]["username"] == "tester"
    assert comments[0]["text"] == "확인 중입니다"


def test_add_comment_rejects_blank_text():
    client, conn = _make_client()
    sync_anomalies(conn, {"999": _sample()})
    anomaly_id = client.get("/delivery-anomaly/list").json()["items"][0]["id"]
    res = client.post(f"/delivery-anomaly/{anomaly_id}/comments", json={"text": "   "})
    assert res.status_code == 400


def test_add_comment_missing_anomaly_returns_404():
    client, _conn = _make_client()
    res = client.post("/delivery-anomaly/9999/comments", json={"text": "hi"})
    assert res.status_code == 404
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_routes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.delivery_anomaly_routes'`

- [ ] **Step 3: 최소 구현 작성**

`backend/api/delivery_anomaly_routes.py` 생성:

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))


def build_delivery_anomaly_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/delivery-anomaly")

    @router.get("/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT a.*, COUNT(c.id) AS comment_count
            FROM delivery_anomalies a
            LEFT JOIN delivery_anomaly_comments c ON c.anomaly_id = a.id
            GROUP BY a.id
            ORDER BY a.detected_at ASC
            """
        ).fetchall()
        conn.close()
        return {
            "items": [
                {
                    "id": r["id"],
                    "invoiceNo": r["invoice_no"],
                    "orderNo": r["order_no"],
                    "productName": r["product_name"],
                    "optionInfo": r["option_info"],
                    "phone": r["phone"],
                    "sentDate": r["sent_date"],
                    "status": r["status"],
                    "location": r["location"],
                    "scanDate": r["scan_date"],
                    "detectedAt": r["detected_at"],
                    "commentCount": r["comment_count"],
                }
                for r in rows
            ]
        }

    @router.get("/{anomaly_id}/comments")
    def list_comments(anomaly_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT id, username, text, created_at FROM delivery_anomaly_comments"
            " WHERE anomaly_id = ? ORDER BY created_at ASC",
            (anomaly_id,),
        ).fetchall()
        conn.close()
        return {
            "items": [
                {"id": r["id"], "username": r["username"], "text": r["text"], "createdAt": r["created_at"]}
                for r in rows
            ]
        }

    @router.post("/{anomaly_id}/comments")
    def add_comment(
        anomaly_id: int,
        text: str = Body(..., embed=True),
        user: str = Depends(get_current_user),
    ):
        text = text.strip()
        if not text:
            raise HTTPException(400, "댓글 내용을 입력하세요")
        conn = get_db()
        exists = conn.execute(
            "SELECT id FROM delivery_anomalies WHERE id = ?", (anomaly_id,)
        ).fetchone()
        if not exists:
            conn.close()
            raise HTTPException(404, "이상현상 항목을 찾을 수 없습니다")
        created_at = datetime.now(_KST).isoformat()
        conn.execute(
            "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
            (anomaly_id, user, text, created_at),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "createdAt": created_at}

    return router
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_routes.py -v`
Expected: PASS (5개 테스트 모두 통과)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/delivery_anomaly_routes.py backend/tests/test_delivery_anomaly_routes.py
git commit -m "feat: add delivery anomaly list/comments endpoints"
```

---

### Task 4: `/run` 엔드포인트 (에이블리+llogis 조회, 하루 1회 가드)

**Files:**
- Modify: `backend/api/delivery_anomaly_routes.py`

**Interfaces:**
- Consumes: `evaluate_anomaly`, `parse_ably_sent_date` (Task 1), `sync_anomalies` (Task 2)
- Produces: `POST /delivery-anomaly/run` — 이 태스크는 실제 외부 API(에이블리/llogis)를 호출하므로 자동화 테스트 없이 **수동 검증**으로 확인한다 (Task 8 참고).

- [ ] **Step 1: helper 함수 및 `/run` 엔드포인트 추가**

`backend/api/delivery_anomaly_routes.py` 상단 import를 다음으로 교체:

```python
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from services.delivery_anomaly_logic import evaluate_anomaly, parse_ably_sent_date
from services.delivery_anomaly_store import sync_anomalies

_KST = timezone(timedelta(hours=9))

ABLY_BASE = "https://api.a-bly.com"
ABLY_EMAIL = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_BASE = "https://pid.alps.llogis.com:18210"
LLOGIS_PRINCIPAL = "348867"
LLOGIS_CREDENTIAL = "1q2w3e4r5t"
LLOGIS_EMP_NO = "348867"

_LAST_RUN_SETTING_KEY = "delivery_anomaly_last_run_date"
```

`build_delivery_anomaly_router` 함수 본문, `router = APIRouter(prefix="/delivery-anomaly")` 바로 아래에 helper 함수들을 추가:

```python
    async def _ably_login() -> str:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/login/",
                json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://my.a-bly.com/",
                    "Origin": "https://my.a-bly.com",
                },
            )
            res.raise_for_status()
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패: 토큰 없음")
        return token

    async def _fetch_ably_shipping_items(token: str) -> list[dict]:
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
        }
        items: list[dict] = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(
                f"{ABLY_BASE}/seller/order_items/",
                headers=headers,
                params={
                    "processing_status[]": 3,
                    "processing_sub_status[]": 0,
                    "order": "goods_sent_at",
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "per_page": 100,
                    "sponsorship_type": -1,
                    "page": 1,
                },
            )
            if res.status_code == 200:
                for item in res.json().get("order_items", []):
                    items.append({
                        "product_name": item.get("goods_name") or "",
                        "option_info": item.get("option_info") or "",
                        "order_no": str(item.get("order_sno") or item.get("sno") or ""),
                        "invoice_no": str(item.get("invoice") or "").strip(),
                        "phone": item.get("receiver_tel") or "",
                        "sent_date": item.get("goods_sent_at") or "",
                    })
        return items

    async def _llogis_login() -> str:
        async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
            res = await client.post(
                LLOGIS_LOGIN_URL,
                json={
                    "principal": LLOGIS_PRINCIPAL,
                    "credential": LLOGIS_CREDENTIAL,
                    "macAddress": "normal-browser",
                },
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://partner.alps.llogis.com/",
                    "Origin": "https://partner.alps.llogis.com",
                },
            )
            res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise HTTPException(status_code=502, detail="llogis 로그인 실패: 토큰 없음")
        return token

    async def _llogis_query(inv_no: str, token: str) -> dict:
        url = f"{LLOGIS_BASE}/pid/ftr/pacltrc/inner/bcraiinvinfo"
        params = {
            "filter": json.dumps(
                {
                    "srchInvNo": inv_no,
                    "blngBrshCd": None,
                    "empno": LLOGIS_EMP_NO,
                    "usrId": LLOGIS_EMP_NO,
                    "currPageId": "PIDFTR001U",
                    "crdFarePrntStat": "N",
                    "srchOrgInvNo": "",
                },
                ensure_ascii=False,
            ),
            "_": str(int(time.time() * 1000)),
        }
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Authorization": token,
            "Content-Type": "application/json",
            "Host": "pid.alps.llogis.com:18210",
            "Referer": f"{LLOGIS_BASE}/pid/pages/ftr/PIDFTR051U",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
        }
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            res = await client.get(url, params=params, headers=headers)
            res.raise_for_status()
        return res.json()
```

그리고 `return router` 바로 위에 `/run` 엔드포인트 추가:

```python
    @router.post("/run")
    async def run_check(user: str = Depends(get_current_user)):
        today_str = datetime.now(_KST).strftime("%Y-%m-%d")
        last_run = get_setting(_LAST_RUN_SETTING_KEY)
        if last_run == today_str:
            return list_anomalies(user=user)  # 오늘 이미 실행됨 — 재조회 없이 현재 목록만 반환

        ably_token = await _ably_login()
        ably_items = await _fetch_ably_shipping_items(ably_token)

        llogis_token = await _llogis_login()
        computed: dict[str, dict] = {}
        today = datetime.now(_KST).date()
        for item in ably_items:
            inv_no = item["invoice_no"]
            if not inv_no:
                continue
            sent_date = parse_ably_sent_date(item["sent_date"])
            try:
                llogis_raw = await _llogis_query(inv_no, llogis_token)
            except Exception:
                continue
            reason = evaluate_anomaly(sent_date, today, llogis_raw)
            if not reason:
                continue
            mvm_list = llogis_raw.get("mvmList") or []
            latest = mvm_list[-1] if mvm_list else {}
            computed[inv_no] = {
                "order_no": item["order_no"],
                "product_name": item["product_name"],
                "option_info": item["option_info"],
                "phone": item["phone"],
                "sent_date": item["sent_date"],
                "status": latest.get("paclStatNm") or "-",
                "location": latest.get("scanBrshNm") or "-",
                "scan_date": latest.get("rgstYmd") or "-",
                "reason": reason,
            }

        conn = get_db()
        sync_anomalies(conn, computed)
        conn.close()
        set_setting(_LAST_RUN_SETTING_KEY, today_str)

        return list_anomalies(user=user)
```

- [ ] **Step 2: 기존 테스트가 여전히 통과하는지 확인**

Run: `cd backend && python -m pytest tests/test_delivery_anomaly_routes.py -v`
Expected: PASS (Task 3의 5개 테스트 그대로 통과 — `/run`은 자동 테스트 대상 아님)

- [ ] **Step 3: 커밋**

```bash
git add backend/api/delivery_anomaly_routes.py
git commit -m "feat: add delivery anomaly run endpoint with daily guard"
```

---

### Task 5: `main.py`에 라우터 등록

**Files:**
- Modify: `backend/main.py:59` 부근 (import), `backend/main.py:1528` 부근 (등록)

**Interfaces:**
- Consumes: `build_delivery_anomaly_router` (Task 3/4), `init_delivery_anomaly_tables` (Task 2), 기존 `_get_current_user`, `_get_shared_db`, `_get_setting`, `_set_setting`

- [ ] **Step 1: import 추가**

`backend/main.py` 59번째 줄(`from api.accident_cargo_routes import build_accident_cargo_router`) 바로 아래에 추가:

```python
from api.accident_cargo_routes import build_accident_cargo_router
from api.delivery_anomaly_routes import build_delivery_anomaly_router
from services.delivery_anomaly_store import init_delivery_anomaly_tables
```

- [ ] **Step 2: 테이블 초기화 + 라우터 등록**

`backend/main.py`의 `accident_cargo_router` 등록 블록(다음 코드) 바로 아래에:

```python
app.include_router(
    build_accident_cargo_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
    )
)
```

다음을 추가:

```python
init_delivery_anomaly_tables(_get_shared_db)

app.include_router(
    build_delivery_anomaly_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        set_setting=_set_setting,
    )
)
```

- [ ] **Step 3: 서버가 정상 기동하는지 확인**

Run: `cd backend && python -c "import main"`
Expected: 에러 없이 종료 (import 성공 시 아무 출력도 없음). 서버가 살아있는지 직접 확인하려면 `cd backend && uvicorn main:app --host 127.0.0.1 --port 8000` 실행 후 다른 터미널에서 `curl -s http://127.0.0.1:8000/docs -o /dev/null -w "%{http_code}\n"` → `200` 확인

- [ ] **Step 4: 커밋**

```bash
git add backend/main.py
git commit -m "feat: register delivery anomaly router in main.py"
```

---

### Task 6: 프론트엔드 `DeliveryAnomalyCard` 컴포넌트

**Files:**
- Create: `src/components/Dashboard/DeliveryAnomalyCard.jsx`
- Modify: `src/components/Dashboard/Dashboard.module.css`

**Interfaces:**
- Consumes: `LOCAL_API_BASE`, `getAuthHeaders`, `handleUnauthorized` (`src/lib/api.js`), 기존 CSS 클래스 `card`, `cardTitle`, `countBadge`, `commentToggleBtn`, `commentCount`, `commentSection`, `commentLoading`, `commentItem`, `commentMeta`, `commentAuthor`, `commentTime`, `commentText`, `commentEmpty`, `commentInputRow`, `commentInput`, `commentSubmitBtn`
- Produces: `export default function DeliveryAnomalyCard()` — props 없음, `Overview.jsx`가 그대로 렌더링

- [ ] **Step 1: CSS 클래스 추가**

`src/components/Dashboard/Dashboard.module.css`의 `.resolvedGrid` 규칙(약 166번째 줄) 바로 위에 추가:

```css
/* ─── Delivery Anomaly Card ─── */
.anomalyList {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.anomalyRow {
  border: 1px solid var(--d-rose-light);
  border-radius: var(--d-radius-md);
  padding: 0.9rem 1.1rem;
  background: var(--d-surface);
}

.anomalyGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 0.5rem 1.25rem;
  margin-bottom: 0.6rem;
  font-size: 0.85rem;
  color: var(--d-text-1);
}

.anomalyField {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  overflow-wrap: break-word;
}

.anomalyFieldLabel {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--d-text-3);
}

```

- [ ] **Step 2: 컴포넌트 작성**

`src/components/Dashboard/DeliveryAnomalyCard.jsx` 생성:

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './Dashboard.module.css';
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from '../../lib/api';

function formatDate(raw) {
    if (!raw) return '-';
    return String(raw).slice(0, 10);
}

function isPastFourPmKst() {
    const now = new Date();
    const kstHour = Number(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            hour12: false,
        }).format(now)
    );
    return kstHour >= 16;
}

export default function DeliveryAnomalyCard() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedIds, setExpandedIds] = useState(new Set());
    const [commentsCache, setCommentsCache] = useState({});
    const authHeaders = getAuthHeaders();

    const fetchList = useCallback(async () => {
        try {
            const res = await fetch(`${API}/delivery-anomaly/list`, { headers: authHeaders });
            if (handleUnauthorized(res)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok) setItems(data.items || []);
        } catch {
            // 로컬 백엔드에 연결할 수 없으면 조용히 무시
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await fetchList();
            if (cancelled) return;
            if (isPastFourPmKst()) {
                try {
                    const res = await fetch(`${API}/delivery-anomaly/run`, {
                        method: 'POST',
                        headers: authHeaders,
                    });
                    if (res.ok && !cancelled) await fetchList();
                } catch {
                    // 로컬 백엔드에 연결할 수 없으면 조용히 무시
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const getCommentState = (id) => commentsCache[id] ?? { items: null, loading: false, input: '', submitting: false };

    const toggleExpanded = async (id) => {
        const isOpen = expandedIds.has(id);
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (isOpen) next.delete(id); else next.add(id);
            return next;
        });
        if (!isOpen && !commentsCache[id]?.items) {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...getCommentState(id), loading: true } }));
            try {
                const res = await fetch(`${API}/delivery-anomaly/${id}/comments`, { headers: authHeaders });
                const data = await res.json().catch(() => ({}));
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], items: data.items || [], loading: false } }));
            } catch {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], loading: false, items: [] } }));
            }
        }
    };

    const submitComment = async (id) => {
        const text = (commentsCache[id]?.input || '').trim();
        if (!text) return;
        setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: true } }));
        try {
            const res = await fetch(`${API}/delivery-anomaly/${id}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ text }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setCommentsCache((prev) => ({
                    ...prev,
                    [id]: {
                        ...prev[id],
                        items: [...(prev[id]?.items || []), { id: `local-${Date.now()}`, username: '나', text, createdAt: data.createdAt }],
                        input: '',
                        submitting: false,
                    },
                }));
                setItems((prev) => prev.map((it) => (it.id === id ? { ...it, commentCount: (it.commentCount || 0) + 1 } : it)));
            } else {
                setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
            }
        } catch {
            setCommentsCache((prev) => ({ ...prev, [id]: { ...prev[id], submitting: false } }));
        }
    };

    if (loading || items.length === 0) return null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTitle}>
                택배 이상현상
                <span className={styles.countBadge}>{items.length}</span>
            </div>
            <div className={styles.anomalyList}>
                {items.map((item) => (
                    <div key={item.id} className={styles.anomalyRow}>
                        <div className={styles.anomalyGrid}>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>주문번호</span>
                                {item.orderNo || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>상품명</span>
                                {item.productName || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>옵션</span>
                                {item.optionInfo || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>전화번호</span>
                                {item.phone || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>발송일</span>
                                {formatDate(item.sentDate)}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>송장번호</span>
                                {item.invoiceNo}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>배송상태</span>
                                {item.status || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>위치</span>
                                {item.location || '-'}
                            </div>
                            <div className={styles.anomalyField}>
                                <span className={styles.anomalyFieldLabel}>최종스캔일</span>
                                {formatDate(item.scanDate)}
                            </div>
                        </div>
                        <button type="button" className={styles.commentToggleBtn} onClick={() => toggleExpanded(item.id)}>
                            <MessageSquare size={11} />
                            댓글
                            {item.commentCount > 0 && <span className={styles.commentCount}>{item.commentCount}</span>}
                            {expandedIds.has(item.id) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        </button>
                        {expandedIds.has(item.id) && (
                            <div className={styles.commentSection}>
                                {commentsCache[item.id]?.loading && <div className={styles.commentLoading}>불러오는 중...</div>}
                                {(commentsCache[item.id]?.items || []).map((c) => (
                                    <div key={c.id} className={styles.commentItem}>
                                        <div className={styles.commentMeta}>
                                            <span className={styles.commentAuthor}>{c.username}</span>
                                            <span className={styles.commentTime}>{formatDate(c.createdAt)}</span>
                                        </div>
                                        <div className={styles.commentText}>{c.text}</div>
                                    </div>
                                ))}
                                {!commentsCache[item.id]?.loading && (commentsCache[item.id]?.items || []).length === 0 && (
                                    <div className={styles.commentEmpty}>댓글이 없습니다.</div>
                                )}
                                <div className={styles.commentInputRow}>
                                    <input
                                        className={styles.commentInput}
                                        placeholder="댓글 입력..."
                                        value={commentsCache[item.id]?.input || ''}
                                        onChange={(e) => setCommentsCache((prev) => ({
                                            ...prev,
                                            [item.id]: { ...getCommentState(item.id), ...prev[item.id], input: e.target.value },
                                        }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                submitComment(item.id);
                                            }
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.commentSubmitBtn}
                                        onClick={() => submitComment(item.id)}
                                        disabled={commentsCache[item.id]?.submitting}
                                    >
                                        등록
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: 린트 확인**

Run: `npm run lint -- --no-fix src/components/Dashboard/DeliveryAnomalyCard.jsx`
Expected: 에러 없음 (경고는 허용)

- [ ] **Step 4: 커밋**

```bash
git add src/components/Dashboard/DeliveryAnomalyCard.jsx src/components/Dashboard/Dashboard.module.css
git commit -m "feat: add DeliveryAnomalyCard component"
```

---

### Task 7: `Overview.jsx`에 카드 삽입

**Files:**
- Modify: `src/components/Dashboard/Overview.jsx`

**Interfaces:**
- Consumes: `DeliveryAnomalyCard` (Task 6)

- [ ] **Step 1: import 추가**

`src/components/Dashboard/Overview.jsx` 4번째 줄(`import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';`) 바로 아래에 추가:

```jsx
import { COLLAB_API_BASE as API, LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from '../../lib/api';
import DeliveryAnomalyCard from './DeliveryAnomalyCard';
```

- [ ] **Step 2: `resolvedGrid` 바로 위에 카드 삽입**

다음 블록을 찾는다 (JSX 반환문 안, `{/* 공동 할 일 - 접기/펼치기 */}` 바로 위):

```jsx
            <div className={styles.resolvedGrid}>
                {/* 공동 할 일 - 접기/펼치기 */}
```

다음으로 교체:

```jsx
            <DeliveryAnomalyCard />

            <div className={styles.resolvedGrid}>
                {/* 공동 할 일 - 접기/펼치기 */}
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 빌드 완료

- [ ] **Step 4: 커밋**

```bash
git add src/components/Dashboard/Overview.jsx
git commit -m "feat: mount DeliveryAnomalyCard above shared todo/sent requests on dashboard"
```

---

### Task 8: 수동 통합 검증

**Files:** 없음 (검증 전용 태스크)

- [ ] **Step 1: 전체 백엔드 테스트 재확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: PASS (Task 1~3에서 작성한 모든 테스트 통과)

- [ ] **Step 2: 로컬 백엔드 기동**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000`

- [ ] **Step 3: `/run`을 직접 호출해 실제 데이터로 채우기**

시간 게이트(오후 4시)와 무관하게 강제로 채우려면, 로그인해서 얻은 토큰으로 직접 호출:

```bash
TOKEN="<로그인 후 얻은 JWT>"
curl -s -X POST http://127.0.0.1:8000/delivery-anomaly/run -H "Authorization: Bearer $TOKEN" | head -c 2000
```

Expected: `{"items": [...]}` 형태 응답. 이상현상이 하나도 없으면 `{"items": []}` — 정상 (현재 에이블리 배송중 목록에 조건에 맞는 오래된 미배송 건이 없다는 뜻).

같은 날 두 번째로 `/run`을 호출하면 재조회 없이 바로 현재 목록만 반환되는지 확인 (가드 동작 확인). 강제로 다시 실행하려면 `app_settings`에서 가드 값을 지운다:

```bash
cd backend && python -c "
import sqlite3
conn = sqlite3.connect('app.db')
conn.execute(\"DELETE FROM app_settings WHERE key='delivery_anomaly_last_run_date'\")
conn.commit()
"
```

- [ ] **Step 4: 프론트엔드에서 카드 확인**

Run: `npm run dev`, 브라우저에서 로그인 후 대시보드 접속.

- Step 3에서 이상현상이 1건 이상 채워졌다면: 대시보드 상단, "공동 할 일"/"보낸 요청" 카드 바로 위에 "택배 이상현상" 카드가 보이는지 확인
- 각 행에 주문번호/상품명/옵션/전화번호/발송일/송장번호/배송상태/위치/최종스캔일이 표시되는지 확인
- "댓글" 토글을 눌러 펼치고, 댓글을 입력해 등록 → 화면에 즉시 반영되는지, 새로고침 후에도 남아있는지(`GET /delivery-anomaly/{id}/comments`로 재확인) 확인
- 이상현상이 0건이면 카드 자체가 렌더링되지 않는지(`items.length === 0`일 때 `null` 반환) 확인

- [ ] **Step 5: 자동 삭제(diff) 동작 확인**

`sqlite3`로 임의 테스트 행을 넣고 다음 `/run` 호출 시 조건에 안 맞으면 사라지는지 확인:

```bash
cd backend && python -c "
import sqlite3
from datetime import datetime, timezone, timedelta
KST = timezone(timedelta(hours=9))
conn = sqlite3.connect('app.db')
conn.execute(
    \"INSERT OR IGNORE INTO delivery_anomalies (invoice_no, order_no, product_name, detected_at) VALUES (?, ?, ?, ?)\",
    ('TEST0000000', 'test-order', '테스트 상품', datetime.now(KST).isoformat()),
)
conn.execute(\"DELETE FROM app_settings WHERE key='delivery_anomaly_last_run_date'\")
conn.commit()
"
```

그 다음 Step 3의 curl로 `/run`을 다시 호출 → 응답의 `items`에 `TEST0000000`이 없는지 확인 (오늘 계산된 실제 이상현상 집합에 없으므로 자동 삭제되어야 함).

---

## Self-Review 결과

- **스펙 커버리지**: 판정 조건(Task 1) / 저장·diff(Task 2) / API(Task 3, 4) / main.py 등록(Task 5) / 프론트 카드+배치(Task 6, 7) / 수동 검증(Task 8) 모두 스펙 항목과 1:1 대응됨. 스펙의 "확인완료 버튼 없음" 요구사항은 Task 2의 diff 로직과 Task 6 컴포넌트 어디에도 resolve 버튼을 두지 않는 것으로 반영됨.
- **플레이스홀더 스캔**: 없음 — 모든 스텝에 실행 가능한 전체 코드/명령 포함.
- **타입/시그니처 일관성**: `evaluate_anomaly(sent_date, today, llogis_raw)` 시그니처가 Task 1 정의부터 Task 4 사용부까지 동일. `sync_anomalies(conn, computed)`도 Task 2~4에서 동일하게 사용. 프론트 필드명(`invoiceNo`, `orderNo`, `productName`, `optionInfo`, `phone`, `sentDate`, `status`, `location`, `scanDate`, `commentCount`, `id`)이 Task 3 API 응답과 Task 6 컴포넌트 사용처에서 동일.
