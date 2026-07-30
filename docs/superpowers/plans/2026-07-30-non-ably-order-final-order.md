# 비에이블리 채널 재고부족 + 최종발주 합산 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EZAdmin IO30(에이블리 외 채널, `multi_shop=10080,10031`)에서
재고/미입고/부족수량 스냅샷을 가져와 저장하고, 에이블리 채널
예상발주수량(확정값 우선)과 합산한 최종발주 목록을 API로 제공한다.

**Architecture:** 기존 `order_recommendation_ezadmin_collectors.py`의
IO30 페이지네이션·파싱 로직을 신규 공용 모듈
`ezadmin_io30_client.py`로 추출한다. 신규
`order_non_ably_backorder.py`가 이 공용 모듈로 비에이블리 채널을
조회해 `yusas_code` PK 스냅샷 테이블(날짜 이력 없음)에 upsert한다.
신규 라우터 `order_non_ably_backorder_routes.py`가 `/collect`,
`/snapshot`, `/final-order` 3개 엔드포인트를 제공하며, `/final-order`는
호출 시점마다 `order_recommendation_daily`와 스냅샷 테이블을 조인해
계산만 하고 저장하지 않는다.

**Tech Stack:** FastAPI + SQLite(공유 DB), httpx(`EzAdminClient` 경유),
pytest + respx.

## Global Constraints

- `order_recommendation_ezadmin_collectors.py`의 기존 동작(에이블리
  콜렉터 3개, 30초 TTL 캐시)은 변경하지 않는다 — 리팩터링 후에도 기존
  7개 테스트가 그대로 통과해야 한다.
- 비에이블리 스냅샷 테이블은 `yusas_code`를 PK로 쓰고 날짜 이력을
  쌓지 않는다 — 매 수집마다 조회된 상품만 덮어쓰고, 이번 조회에 없는
  기존 행은 삭제하지 않는다.
- `/final-order`는 `ably_order_qty = confirmed_qty if not None else
  (recommended_qty if not None else 0)`, `final_order_qty =
  ably_order_qty + (non_ably_lack_qty or 0)`로 계산하고 아무것도
  저장하지 않는다. 두 소스 중 한쪽에만 있는 상품도 결과에 포함한다.
- 비에이블리 채널은 수요예측/평가 로직을 갖지 않는다 — 저장하는 값은
  EZAdmin이 계산한 `lack_qty`뿐이다.

참고 스펙: `docs/superpowers/specs/2026-07-30-non-ably-order-final-order-design.md`

---

### Task 1: 공용 모듈 추출 — `ezadmin_io30_client.py`

**Files:**
- Create: `backend/services/ezadmin_io30_client.py`
- Modify: `backend/services/order_recommendation_ezadmin_collectors.py`
- Test: `backend/tests/test_order_recommendation_ezadmin_collectors.py`(기존
  파일, 수정 없음 — 회귀 확인용)

**Interfaces:**
- Consumes: `sdk.ezadmin.EzAdminClient`, `sdk.config.EZADMIN_BASE`.
- Produces:
  - `ez_val(html_value) -> str`
  - `to_int(value, default: int = 0) -> int`
  - `fetch_io30_rows(get_setting, *, shop_par_fragment: str) -> list[dict]`
    — IO30을 페이지네이션 조회해 각 행의 `cell` 딕셔너리 리스트를
    그대로 반환(컬럼 매핑은 호출부 책임).

이 태스크는 순수 리팩터링(동작 변경 없음)이라 새 테스트를 먼저 쓰는
대신, 기존 테스트를 리팩터링 전후로 실행해 회귀가 없는지 확인하는
방식으로 진행한다.

- [ ] **Step 1: 리팩터링 전 기존 테스트 통과 확인(베이스라인)**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ezadmin_collectors.py -v`
Expected: PASS (7개 전부 — 리팩터링 전 현재 상태)

- [ ] **Step 2: `backend/services/ezadmin_io30_client.py` 생성**

```python
from __future__ import annotations

import re
from datetime import datetime, timedelta

from sdk import config
from sdk.ezadmin import EzAdminClient

_MAX_PAGES = 20
_PAGE_ROWS = 1000


def ez_val(html_value) -> str:
    """EZAdmin 셀 값에서 실값을 뽑아낸다: <input value='X'> → X, <a>X</a> → X,
    태그 없으면 그대로. order_routes.py의 동일 로직(로컬 클로저라 임포트
    불가)을 여기 독립적으로 재구현한 것."""
    s = str(html_value or "")
    m = re.search(r"<input[^>]+\bvalue=['\"]([^'\"]*)['\"]", s, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r">([^<]+)</a>", s)
    if m:
        return m.group(1).strip()
    return re.sub(r"<[^>]+>", "", s).strip()


def to_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _io30_par(shop_par_fragment: str, start_date: str, end_date: str) -> str:
    return (
        "template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
        "_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
        "offset_top=&work_no=&location_str=&date_type=collect_date&"
        f"start_date={start_date}&start_hour=00%3A00%3A00&"
        f"end_date={end_date}&end_hour=23%3A59%3A59&"
        f"date_period_sel=9&{shop_par_fragment}&"
        "multi_supply_group=&multi_supply=&str_supply_code=0&"
        "supply_name_search=&brand=&supply_options=&tags_string=&"
        "product_tag_include_type=1&product_id=&name=&options=&"
        "search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
        "order_status=3&except_soldout=1&sel_reserve_qty=none&"
        "sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
    )


async def fetch_io30_rows(get_setting, *, shop_par_fragment: str) -> list[dict]:
    """EZAdmin IO30을 shop_par_fragment(예:
    "multi_shop_group=&multi_shop=&str_shop_code=10028") 필터로 페이지네이션
    조회해서 각 행의 cell 딕셔너리 리스트를 그대로 반환한다(컬럼 매핑은
    호출부 책임). PHPSESSID 미설정/세션 만료 시 EzAdminSessionExpired가
    그대로 전파된다."""
    client = EzAdminClient(get_setting)
    today = datetime.now()
    start = (today - timedelta(days=90)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    par = _io30_par(shop_par_fragment, start, end)
    referer_headers = {"Referer": f"{config.EZADMIN_BASE}/template40.htm?template=IO30"}

    rows: list[dict] = []
    page = 1
    while True:
        nd = str(int(datetime.now().timestamp() * 1000))
        data = await client.post(
            "IO30", "search_IO30",
            data={"_search": "false", "nd": nd, "rows": str(_PAGE_ROWS), "page": str(page), "sidx": "", "sord": "asc"},
            par=par,
            time_flag=None,
            extra_headers=referer_headers,
        )
        for row in data.get("rows") or []:
            rows.append(row.get("cell", row))

        total_pages = int(data.get("total") or 1)
        if page >= total_pages or page >= _MAX_PAGES:
            break
        page += 1

    return rows
```

- [ ] **Step 3: `order_recommendation_ezadmin_collectors.py`를 공용 모듈 사용하도록 교체**

파일 전체를 다음으로 교체(캐싱/컬럼 매핑 동작은 동일, 페이지네이션/파싱만
`ezadmin_io30_client`로 위임):

```python
from __future__ import annotations

import time

from services.ezadmin_io30_client import ez_val, fetch_io30_rows, to_int

_CACHE_TTL_SECONDS = 30
_ABLY_SHOP_CODE = "10028"

_cache: dict[str, tuple[float, dict[str, dict]]] = {}


async def _fetch_ably_io30_snapshot(get_setting, date: str) -> dict[str, dict]:
    """EZAdmin IO30(에이블리 채널, str_shop_code=10028)을 조회해
    {product_id: {"stock_qty", "incoming_qty", "ezadmin_lack_qty"}}로 반환한다.
    같은 date로 _CACHE_TTL_SECONDS 안에 재호출되면 캐시를 재사용한다.
    PHPSESSID 미설정/세션 만료 시 EzAdminSessionExpired가 그대로 전파된다
    (실패한 조회는 캐시하지 않음)."""
    cached = _cache.get(date)
    now = time.monotonic()
    if cached is not None and (now - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1]

    rows = await fetch_io30_rows(
        get_setting,
        shop_par_fragment=f"multi_shop_group=&multi_shop=&str_shop_code={_ABLY_SHOP_CODE}",
    )

    snapshot: dict[str, dict] = {}
    for cell in rows:
        product_id = ez_val(cell.get("product_id")).strip()
        if not product_id:
            continue
        snapshot[product_id] = {
            "stock_qty": to_int(ez_val(cell.get("stock"))),
            "incoming_qty": to_int(ez_val(cell.get("not_yet_deliv"))),
            "ezadmin_lack_qty": to_int(ez_val(cell.get("lack_qty"))),
        }

    _cache[date] = (now, snapshot)
    return snapshot


def build_ezadmin_collectors(get_setting) -> dict:
    async def _collect_column(column: str, date: str) -> dict:
        snapshot = await _fetch_ably_io30_snapshot(get_setting, date)
        return {code: values[column] for code, values in snapshot.items()}

    async def collect_stock_qty(date: str) -> dict:
        return await _collect_column("stock_qty", date)

    async def collect_incoming_qty(date: str) -> dict:
        return await _collect_column("incoming_qty", date)

    async def collect_ezadmin_lack_qty(date: str) -> dict:
        return await _collect_column("ezadmin_lack_qty", date)

    return {
        "stock_qty": collect_stock_qty,
        "incoming_qty": collect_incoming_qty,
        "ezadmin_lack_qty": collect_ezadmin_lack_qty,
    }
```

- [ ] **Step 4: 회귀 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ezadmin_collectors.py -v`
Expected: PASS (7개 전부 — 리팩터링 후에도 동일하게 통과)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/ezadmin_io30_client.py backend/services/order_recommendation_ezadmin_collectors.py
git commit -m "refactor: extract shared EZAdmin IO30 pagination/parsing into ezadmin_io30_client"
```

---

### Task 2: `order_non_ably_backorder.py` — 스냅샷 테이블 + 수집

**Files:**
- Create: `backend/services/order_non_ably_backorder.py`
- Test: `backend/tests/test_order_non_ably_backorder.py`

**Interfaces:**
- Consumes: `services.ezadmin_io30_client.ez_val`, `to_int`,
  `fetch_io30_rows`. `services.order_recommendation_store.now_kst_iso`.
- Produces:
  - `init_non_ably_backorder_table(get_db) -> None`
  - `fetch_non_ably_snapshot(get_setting) -> dict[str, dict]` —
    `{yusas_code: {"stock_qty", "incoming_qty", "lack_qty"}}`
  - `upsert_non_ably_snapshot(conn, snapshot: dict[str, dict]) -> None`
  - `collect_non_ably_snapshot(get_db, get_setting) -> int` — upsert된
    상품 수 반환.
  - `list_non_ably_snapshot(conn) -> list` — `yusas_code` 순 정렬.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_non_ably_backorder.py` 생성:

```python
import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.ezadmin import EzAdminSessionExpired
from services.order_non_ably_backorder import (
    collect_non_ably_snapshot,
    fetch_non_ably_snapshot,
    init_non_ably_backorder_table,
    list_non_ably_snapshot,
    upsert_non_ably_snapshot,
)

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _make_db_factory():
    uri = f"file:test_order_non_ably_backorder_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _setting(sessid="sess123"):
    return lambda key: sessid if key == "ezadmin_phpsessid" else None


def _cell(product_id, stock, not_yet_deliv, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "not_yet_deliv": f"<a class=atd href='#' onclick=javascript:run_not_yet_deliv(this)>{not_yet_deliv}</a>",
        "lack_qty": str(lack_qty),
    }


def test_init_creates_table_with_expected_columns():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_non_ably_backorder)").fetchall()}
    assert cols == {"yusas_code", "stock_qty", "incoming_qty", "lack_qty", "updated_at"}
    conn.close()


def test_init_is_idempotent():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    init_non_ably_backorder_table(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_non_ably_backorder)").fetchall()}
    assert "yusas_code" in cols
    conn.close()


def test_upsert_inserts_new_rows():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    })

    rows = list_non_ably_snapshot(conn)
    assert [r["yusas_code"] for r in rows] == ["S24067", "S24083"]
    row = conn.execute(
        "SELECT * FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()
    assert row["stock_qty"] == 0
    assert row["incoming_qty"] == 5
    assert row["lack_qty"] == 3
    assert row["updated_at"] is not None
    conn.close()


def test_upsert_overwrites_existing_row_values():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3}})
    first_updated_at = conn.execute(
        "SELECT updated_at FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()["updated_at"]

    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 10, "incoming_qty": 0, "lack_qty": 0}})

    row = conn.execute(
        "SELECT * FROM order_non_ably_backorder WHERE yusas_code = ?", ("S24083",)
    ).fetchone()
    assert row["stock_qty"] == 10
    assert row["incoming_qty"] == 0
    assert row["lack_qty"] == 0
    assert row["updated_at"] is not None
    assert first_updated_at is not None
    conn.close()


def test_upsert_preserves_rows_not_in_new_snapshot():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    })
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 9, "incoming_qty": 0, "lack_qty": 0}})

    rows = {r["yusas_code"]: r for r in list_non_ably_snapshot(conn)}
    assert set(rows.keys()) == {"S24083", "S24067"}
    assert rows["S24067"]["stock_qty"] == 2
    conn.close()


@respx.mock
def test_fetch_non_ably_snapshot_parses_response():
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "rows": [
                    {"id": 0, "cell": _cell("S24083", 0, 5, 3)},
                    {"id": 1, "cell": _cell("S24067", 2, 1, 0)},
                ],
                "total": 1,
            },
        )
    )

    snapshot = asyncio.run(fetch_non_ably_snapshot(_setting()))

    assert snapshot == {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
    }


def test_fetch_non_ably_snapshot_raises_session_expired_when_no_phpsessid_configured():
    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(fetch_non_ably_snapshot(_setting(sessid=None)))


@respx.mock
def test_collect_non_ably_snapshot_fetches_and_upserts_returns_count():
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "rows": [
                    {"id": 0, "cell": _cell("S24083", 0, 5, 3)},
                    {"id": 1, "cell": _cell("S24067", 2, 1, 0)},
                ],
                "total": 1,
            },
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)

    count = asyncio.run(collect_non_ably_snapshot(get_db, _setting()))

    assert count == 2
    conn = get_db()
    rows = list_non_ably_snapshot(conn)
    assert len(rows) == 2
    conn.close()


def test_list_non_ably_snapshot_returns_rows_ordered_by_yusas_code():
    get_db, _keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    conn = get_db()

    upsert_non_ably_snapshot(conn, {
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "lack_qty": 0},
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "lack_qty": 3},
    })

    rows = list_non_ably_snapshot(conn)
    assert [r["yusas_code"] for r in rows] == ["S24067", "S24083"]
    conn.close()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_non_ably_backorder.py -v`
Expected: FAIL — `services.order_non_ably_backorder` 모듈이 아직 없어
ImportError.

- [ ] **Step 3: `backend/services/order_non_ably_backorder.py` 구현**

```python
from __future__ import annotations

from services.ezadmin_io30_client import ez_val, fetch_io30_rows, to_int
from services.order_recommendation_store import now_kst_iso

_NON_ABLY_SHOP_CODES = "10080,10031"


def init_non_ably_backorder_table(get_db) -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS order_non_ably_backorder (
            yusas_code TEXT PRIMARY KEY,
            stock_qty INTEGER,
            incoming_qty INTEGER,
            lack_qty INTEGER,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


async def fetch_non_ably_snapshot(get_setting) -> dict[str, dict]:
    rows = await fetch_io30_rows(
        get_setting,
        shop_par_fragment=f"multi_shop_group=&multi_shop={_NON_ABLY_SHOP_CODES}&str_shop_code=0",
    )
    snapshot: dict[str, dict] = {}
    for cell in rows:
        product_id = ez_val(cell.get("product_id")).strip()
        if not product_id:
            continue
        snapshot[product_id] = {
            "stock_qty": to_int(ez_val(cell.get("stock"))),
            "incoming_qty": to_int(ez_val(cell.get("not_yet_deliv"))),
            "lack_qty": to_int(ez_val(cell.get("lack_qty"))),
        }
    return snapshot


def upsert_non_ably_snapshot(conn, snapshot: dict[str, dict]) -> None:
    now = now_kst_iso()
    for yusas_code, values in snapshot.items():
        conn.execute(
            """
            INSERT INTO order_non_ably_backorder (yusas_code, stock_qty, incoming_qty, lack_qty, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(yusas_code) DO UPDATE SET
                stock_qty = excluded.stock_qty,
                incoming_qty = excluded.incoming_qty,
                lack_qty = excluded.lack_qty,
                updated_at = excluded.updated_at
            """,
            (yusas_code, values["stock_qty"], values["incoming_qty"], values["lack_qty"], now),
        )
    conn.commit()


async def collect_non_ably_snapshot(get_db, get_setting) -> int:
    snapshot = await fetch_non_ably_snapshot(get_setting)
    conn = get_db()
    try:
        upsert_non_ably_snapshot(conn, snapshot)
    finally:
        conn.close()
    return len(snapshot)


def list_non_ably_snapshot(conn) -> list:
    return conn.execute("SELECT * FROM order_non_ably_backorder ORDER BY yusas_code").fetchall()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_non_ably_backorder.py -v`
Expected: PASS (9개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_non_ably_backorder.py backend/tests/test_order_non_ably_backorder.py
git commit -m "feat: add non-Ably channel backorder snapshot collector"
```

---

### Task 3: API — `/non-ably-order/collect`, `/snapshot`, `/final-order`

**Files:**
- Create: `backend/api/order_non_ably_backorder_routes.py`
- Test: `backend/tests/test_order_non_ably_backorder_routes.py`

**Interfaces:**
- Consumes: `services.order_non_ably_backorder.collect_non_ably_snapshot`,
  `list_non_ably_snapshot`, `init_non_ably_backorder_table`.
  `services.order_recommendation_store.today_kst`,
  `init_order_recommendation_tables`, `ensure_row`.
  `sdk.ezadmin.EzAdminSessionExpired`.
- Produces: `build_non_ably_order_router(*, get_current_user, get_db,
  get_setting)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_non_ably_backorder_routes.py` 생성:

```python
import sqlite3
import sys
import uuid
from pathlib import Path

import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.order_non_ably_backorder_routes import build_non_ably_order_router
from services.order_non_ably_backorder import init_non_ably_backorder_table
from services.order_recommendation_store import ensure_row, init_order_recommendation_tables, today_kst

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _make_db_factory():
    uri = f"file:test_non_ably_order_routes_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _make_client(settings=None):
    get_db, keep_alive = _make_db_factory()
    init_non_ably_backorder_table(get_db)
    init_order_recommendation_tables(get_db)

    app = FastAPI()
    app.include_router(
        build_non_ably_order_router(
            get_current_user=lambda: "tester",
            get_db=get_db,
            get_setting=lambda key: (settings or {}).get(key),
        )
    )
    return TestClient(app), get_db, keep_alive


def _cell(product_id, stock, not_yet_deliv, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "not_yet_deliv": f"<a class=atd href='#' onclick=javascript:run_not_yet_deliv(this)>{not_yet_deliv}</a>",
        "lack_qty": str(lack_qty),
    }


def test_snapshot_endpoint_returns_empty_list_initially():
    client, _get_db, _keep_alive = _make_client()
    res = client.get("/non-ably-order/snapshot")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "items": []}


@respx.mock
def test_collect_endpoint_invokes_ezadmin_and_upserts_snapshot():
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 1},
        )
    )
    client, _get_db, _keep_alive = _make_client(settings={"ezadmin_phpsessid": "sess"})

    res = client.post("/non-ably-order/collect")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "updated_codes": 1}

    res2 = client.get("/non-ably-order/snapshot")
    items = res2.json()["items"]
    assert len(items) == 1
    assert items[0]["yusas_code"] == "S24083"
    assert items[0]["lack_qty"] == 3


def test_collect_endpoint_returns_need_session_when_ezadmin_session_expired():
    client, _get_db, _keep_alive = _make_client()  # no ezadmin_phpsessid configured

    res = client.post("/non-ably-order/collect")
    assert res.status_code == 200
    assert res.json() == {"ok": False, "need_session": True}


def test_final_order_uses_confirmed_qty_when_present():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8, confirmed_qty = 10 "
        "WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 3}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S24083",
        "recommended_qty": 8,
        "confirmed_qty": 10,
        "ably_order_qty": 10,
        "non_ably_lack_qty": 3,
        "final_order_qty": 13,
    }


def test_final_order_uses_recommended_qty_when_confirmed_missing():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8 WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S24083": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 3}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    item = res.json()["items"][0]
    assert item["ably_order_qty"] == 8
    assert item["final_order_qty"] == 11


def test_final_order_includes_non_ably_only_product():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    from services.order_non_ably_backorder import upsert_non_ably_snapshot
    upsert_non_ably_snapshot(conn, {"S99999": {"stock_qty": 0, "incoming_qty": 0, "lack_qty": 5}})
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": today_kst()})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S99999",
        "recommended_qty": None,
        "confirmed_qty": None,
        "ably_order_qty": 0,
        "non_ably_lack_qty": 5,
        "final_order_qty": 5,
    }


def test_final_order_includes_ably_only_product():
    client, get_db, _keep_alive = _make_client()
    conn = get_db()
    date = today_kst()
    ensure_row(conn, date, "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET recommended_qty = 8 WHERE date = ? AND yusas_code = ?",
        (date, "S24083"),
    )
    conn.commit()
    conn.close()

    res = client.get("/non-ably-order/final-order", params={"date": date})
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0] == {
        "yusas_code": "S24083",
        "recommended_qty": 8,
        "confirmed_qty": None,
        "ably_order_qty": 8,
        "non_ably_lack_qty": 0,
        "final_order_qty": 8,
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_non_ably_backorder_routes.py -v`
Expected: FAIL — `api.order_non_ably_backorder_routes` 모듈이 아직
없어 ImportError.

- [ ] **Step 3: `backend/api/order_non_ably_backorder_routes.py` 구현**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends

from sdk.ezadmin import EzAdminSessionExpired
from services.order_non_ably_backorder import collect_non_ably_snapshot, list_non_ably_snapshot
from services.order_recommendation_store import today_kst


def _row_to_dict(row) -> dict:
    return {key: row[key] for key in row.keys()}


def build_non_ably_order_router(*, get_current_user, get_db, get_setting):
    router = APIRouter(prefix="/non-ably-order", tags=["non-ably-order"])

    @router.post("/collect")
    async def collect(user: str = Depends(get_current_user)):
        try:
            count = await collect_non_ably_snapshot(get_db, get_setting)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        return {"ok": True, "updated_codes": count}

    @router.get("/snapshot")
    def snapshot(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = list_non_ably_snapshot(conn)
            return {"ok": True, "items": [_row_to_dict(r) for r in rows]}
        finally:
            conn.close()

    @router.get("/final-order")
    def final_order(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        conn = get_db()
        try:
            ably_rows = {
                r["yusas_code"]: r
                for r in conn.execute(
                    "SELECT yusas_code, recommended_qty, confirmed_qty "
                    "FROM order_recommendation_daily WHERE date = ?",
                    (target_date,),
                ).fetchall()
            }
            non_ably_rows = {
                r["yusas_code"]: r["lack_qty"]
                for r in conn.execute("SELECT yusas_code, lack_qty FROM order_non_ably_backorder").fetchall()
            }
        finally:
            conn.close()

        codes = sorted(set(ably_rows.keys()) | set(non_ably_rows.keys()))
        items = []
        for code in codes:
            ably_row = ably_rows.get(code)
            recommended_qty = ably_row["recommended_qty"] if ably_row is not None else None
            confirmed_qty = ably_row["confirmed_qty"] if ably_row is not None else None
            ably_order_qty = confirmed_qty if confirmed_qty is not None else (recommended_qty or 0)
            non_ably_lack_qty = non_ably_rows.get(code) or 0
            items.append({
                "yusas_code": code,
                "recommended_qty": recommended_qty,
                "confirmed_qty": confirmed_qty,
                "ably_order_qty": ably_order_qty,
                "non_ably_lack_qty": non_ably_lack_qty,
                "final_order_qty": ably_order_qty + non_ably_lack_qty,
            })
        return {"ok": True, "date": target_date, "items": items}

    return router
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_non_ably_backorder_routes.py -v`
Expected: PASS (7개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_non_ably_backorder_routes.py backend/tests/test_order_non_ably_backorder_routes.py
git commit -m "feat: add non-Ably order collect/snapshot/final-order API endpoints"
```

---

### Task 4: `main.py` 배선

**Files:**
- Modify: `backend/main.py`

**Interfaces:**
- Consumes: `services.order_non_ably_backorder.init_non_ably_backorder_table`,
  `api.order_non_ably_backorder_routes.build_non_ably_order_router`.
- Produces: 없음(앱 시작 시 부수효과로 테이블 생성 + 라우터 등록).

이 태스크도 main.py 와이어링이라 기존 라운드들과 동일하게 `python -c
"import main"` 스모크 체크로 검증한다.

- [ ] **Step 1: import 추가**

`backend/main.py`의 기존
`from services.order_recommendation_ezadmin_collectors import
build_ezadmin_collectors` 줄(파일 상단, 52번째 줄 근처) 바로 다음에
추가:

```python
from services.order_non_ably_backorder import init_non_ably_backorder_table
from api.order_non_ably_backorder_routes import build_non_ably_order_router
```

- [ ] **Step 2: 테이블 초기화 추가**

`init_order_recommendation_tables(_get_shared_db)` 줄(847번째 줄 근처)
바로 다음에 추가:

```python
init_non_ably_backorder_table(_get_shared_db)
```

- [ ] **Step 3: 라우터 등록 추가**

`for _ez_column, _ez_fn in build_ezadmin_collectors(_get_setting).items():
    register_collector(_ez_column, _ez_fn)` 블록(1432~1433번째 줄
근처) 바로 다음에 추가:

```python
app.include_router(
    build_non_ably_order_router(
        get_current_user=_get_current_user,
        get_db=_get_shared_db,
        get_setting=_get_setting,
    )
)
```

- [ ] **Step 4: 배선 확인**

Run:
```bash
cd backend && python -c "
import main
print([r.path for r in main.app.routes if 'non-ably-order' in r.path])
"
```
Expected: 에러 없이 `['/non-ably-order/collect', '/non-ably-order/snapshot', '/non-ably-order/final-order']`
포함된 리스트 출력.

- [ ] **Step 5: 커밋**

```bash
git add backend/main.py
git commit -m "feat: wire non-Ably order collector and API into app startup"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/test_order_recommendation_ezadmin_collectors.py tests/test_order_non_ably_backorder.py tests/test_order_non_ably_backorder_routes.py -v`
      전체 PASS (7 + 9 + 7 = 23개, 기존 7개는 리팩터링 회귀 확인용)
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
      — 기존 249개 + 신규 16개(order_non_ably_backorder 9 + 라우트 7) =
      265개
