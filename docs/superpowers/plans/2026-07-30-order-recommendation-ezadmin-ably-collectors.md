# 추천발주: EZAdmin 에이블리 채널 컬렉터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EZAdmin IO30(에이블리 채널, `str_shop_code=10028`)을 조회해
`order_recommendation_daily`의 `stock_qty`/`incoming_qty`/신규
`ezadmin_lack_qty`를 매일 채우는 실 컬렉터 3개를 등록한다.

**Architecture:** 신규 `backend/services/order_recommendation_ezadmin_collectors.py`가
`sdk/ezadmin.py`의 `EzAdminClient`로 IO30을 페이지네이션 조회해 상품별
스냅샷(`{product_id: {stock_qty, incoming_qty, ezadmin_lack_qty}}`)을
만들고, 30초 TTL 메모리 캐시로 공유한다. `build_ezadmin_collectors(get_setting)`가
기존 `register_collector(column, fn)` 계약에 맞는 클로저 3개를 만들어
반환하고, `main.py`가 이를 등록한다. `POST /order-recommendation/collect`는
`EzAdminSessionExpired`를 캐치해 `{"ok": false, "need_session": true}`로
응답한다.

**Tech Stack:** FastAPI + SQLite(공유 DB), httpx(`EzAdminClient` 경유),
pytest + respx(HTTP 모킹).

## Global Constraints

- `product_id`(예: `S24083`)를 정규화 없이 그대로 `yusas_code`에 저장한다
  — `barcode_core.normalize_to_yusas`는 이번 라운드에서 쓰지 않는다.
- `ezadmin_lack_qty`는 원시값만 저장한다 — `recommended_qty`와의 비교
  로직/컬럼은 만들지 않는다(비범위).
- 이번 라운드는 에이블리 채널(`str_shop_code=10028`)만 연결한다 —
  에이블리 외 채널(`multi_shop=10080,10031`)은 완전히 다른 워크플로우로
  다음 라운드.
- `stock_qty`/`incoming_qty`/`ezadmin_lack_qty` 3개 컬렉터는 IO30 조회
  결과를 공유한다(30초 TTL 캐시) — `register_collector`가 컬럼당 함수
  1개인 기존 계약은 바꾸지 않는다.
- IO30 페이지네이션은 기존 `order_routes.py`의 `main_order_list`와
  동일한 안전장치(최대 20페이지 × 1000행)를 따른다.
- IO30 응답 Referer는 `{EZADMIN_BASE}/template40.htm?template=IO30`
  이어야 한다(`EzAdminClient.post`의 기본 Referer와 다름 — `main_order_list`로
  검증된 값).

참고 스펙: `docs/superpowers/specs/2026-07-30-order-recommendation-ezadmin-ably-collectors-design.md`

---

### Task 1: DB 스키마 — `ezadmin_lack_qty` 컬럼 + 컬렉터 화이트리스트

**Files:**
- Modify: `backend/services/order_recommendation_store.py`
- Modify: `backend/services/order_recommendation_collect.py`
- Modify: `backend/tests/test_order_recommendation_store.py`
- Modify: `backend/tests/test_order_recommendation_collect.py`

**Interfaces:**
- Consumes: 없음.
- Produces: `init_order_recommendation_tables(get_db) -> None`(시그니처
  변경 없음). 신규 `_ensure_ezadmin_columns(conn) -> None`(private).
  `ALLOWED_COLLECTOR_COLUMNS`에 `"ezadmin_lack_qty"` 포함.

- [ ] **Step 1: 실패하는 테스트로 수정**

`backend/tests/test_order_recommendation_store.py`의 `EXPECTED_COLUMNS`를
다음으로 교체(`actual_received_qty` 바로 다음에 `ezadmin_lack_qty` 추가):

```python
EXPECTED_COLUMNS = {
    "date", "yusas_code", "day_of_week",
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "ezadmin_lack_qty",
    "previous_day_sales_qty",
    "ad_budget", "wish_count", "cart_count",
    "ad_budget_change", "ad_budget_change_rate",
    "wish_count_change", "wish_count_change_rate",
    "cart_count_change", "cart_count_change_rate",
    "incoming_qty_change", "incoming_qty_change_rate",
    "sales_7d", "sales_14d", "avg_sales_7d", "avg_sales_14d",
    "weekday_average_sales", "expected_sales_today",
    "model_version", "model_weight_weekday", "model_weight_previous_day",
    "model_weight_avg_7d", "model_weight_avg_14d",
    "recommended_qty",
    "forecast_error", "absolute_error", "within_20_percent", "evaluated_at",
    "confirm_deviation", "fulfillment_gap", "order_performance_evaluated_at",
    "confirmed_qty", "override_reason", "updated_by", "updated_at",
    "excluded_from_avg", "created_at",
}
```

파일 끝에 테스트 2개 추가:

```python
def test_init_adds_ezadmin_lack_qty_column_to_legacy_table_missing_it():
    get_db, _keep_alive = _make_db_factory()
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE order_recommendation_daily (
            date TEXT NOT NULL,
            yusas_code TEXT NOT NULL,
            sales_qty INTEGER,
            created_at TEXT NOT NULL,
            PRIMARY KEY (date, yusas_code)
        )
        """
    )
    conn.commit()
    conn.close()

    init_order_recommendation_tables(get_db)

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "ezadmin_lack_qty" in cols
    conn.close()


def test_init_is_idempotent_when_ezadmin_lack_qty_already_present():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    init_order_recommendation_tables(get_db)  # 두 번째 호출도 에러 없이 통과해야 함

    conn = get_db()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()}
    assert "ezadmin_lack_qty" in cols
    conn.close()
```

`backend/tests/test_order_recommendation_collect.py`의
`test_register_collector_allows_whitelisted_column` 안의 assert를 다음으로
교체:

```python
        assert ALLOWED_COLLECTOR_COLUMNS == {
            "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
            "ezadmin_lack_qty", "ad_budget", "wish_count", "cart_count",
        }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py tests/test_order_recommendation_collect.py -v`
Expected: FAIL — store 3개(`test_init_creates_table_with_expected_columns`,
신규 2개), collect 1개(`test_register_collector_allows_whitelisted_column`).

- [ ] **Step 3: `order_recommendation_store.py`/`order_recommendation_collect.py` 수정**

`init_order_recommendation_tables`의 `CREATE TABLE` 안, `actual_received_qty INTEGER,`
바로 다음 줄에 추가:

```sql
            ezadmin_lack_qty INTEGER,
```

`init_order_recommendation_tables` 함수 본문의 `_ensure_order_performance_columns(conn)`
호출 다음 줄에 추가:

```python
    _ensure_ezadmin_columns(conn)
```

파일 끝(`_ensure_order_performance_columns` 다음)에 추가:

```python
_EZADMIN_COLUMNS = [
    ("ezadmin_lack_qty", "INTEGER"),
]


def _ensure_ezadmin_columns(conn) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(order_recommendation_daily)").fetchall()]
    for column, ddl_type in _EZADMIN_COLUMNS:
        if column not in cols:
            conn.execute(f"ALTER TABLE order_recommendation_daily ADD COLUMN {column} {ddl_type}")
```

`backend/services/order_recommendation_collect.py`의 `ALLOWED_COLLECTOR_COLUMNS`를:

```python
ALLOWED_COLLECTOR_COLUMNS = {
    "sales_qty", "stock_qty", "incoming_qty", "actual_received_qty",
    "ezadmin_lack_qty", "ad_budget", "wish_count", "cart_count",
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_store.py tests/test_order_recommendation_collect.py -v`
Expected: PASS (store 15개 — 기존 13개 + 신규 2개, collect 5개 — 개수
변화 없음, assert 값만 수정됨)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_store.py backend/services/order_recommendation_collect.py backend/tests/test_order_recommendation_store.py backend/tests/test_order_recommendation_collect.py
git commit -m "feat: add ezadmin_lack_qty column and whitelist entry"
```

---

### Task 2: `order_recommendation_ezadmin_collectors.py` — IO30 조회 + 캐싱 + 컬렉터 빌더

**Files:**
- Create: `backend/services/order_recommendation_ezadmin_collectors.py`
- Test: `backend/tests/test_order_recommendation_ezadmin_collectors.py`

**Interfaces:**
- Consumes: `sdk.ezadmin.EzAdminClient`(`.post(template, action, *, data, par,
  time_flag, extra_headers) -> dict`, PHPSESSID 없으면
  `EzAdminSessionExpired` 발생), `sdk.config.EZADMIN_BASE`.
- Produces:
  - `_fetch_ably_io30_snapshot(get_setting, date: str) -> dict[str, dict]`
    — `{product_id: {"stock_qty": int, "incoming_qty": int,
    "ezadmin_lack_qty": int}}`.
  - `build_ezadmin_collectors(get_setting) -> dict[str, Callable[[str],
    Awaitable[dict]]]` — `{"stock_qty": fn, "incoming_qty": fn,
    "ezadmin_lack_qty": fn}`, 각 `fn(date) -> {yusas_code: value}`
    (`register_collector` 계약과 동일).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_ezadmin_collectors.py` 생성:

```python
import asyncio
import sys
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.order_recommendation_ezadmin_collectors as ez_collect_mod
from sdk.ezadmin import EzAdminSessionExpired
from services.order_recommendation_ezadmin_collectors import (
    _fetch_ably_io30_snapshot,
    build_ezadmin_collectors,
)

_IO30_URL = "https://ga80.ezadmin.co.kr/function.htm"


def _setting(sessid="sess123"):
    return lambda key: sessid if key == "ezadmin_phpsessid" else None


def _cell(product_id, stock, not_yet_deliv, lack_qty):
    return {
        "product_id": product_id,
        "stock": f"<a class=atd href='#' onclick=javascript:run_stock(this)>{stock}</a>",
        "not_yet_deliv": f"<a class=atd href='#' onclick=javascript:run_not_yet_deliv(this)>{not_yet_deliv}</a>",
        "lack_qty": str(lack_qty),
    }


@respx.mock
def test_fetch_snapshot_parses_single_page_response():
    ez_collect_mod._cache.clear()
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

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert snapshot == {
        "S24083": {"stock_qty": 0, "incoming_qty": 5, "ezadmin_lack_qty": 3},
        "S24067": {"stock_qty": 2, "incoming_qty": 1, "ezadmin_lack_qty": 0},
    }


@respx.mock
def test_fetch_snapshot_skips_rows_with_empty_product_id():
    ez_collect_mod._cache.clear()
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200,
            json={"rows": [{"id": 0, "cell": _cell("", 0, 5, 3)}], "total": 1},
        )
    )

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert snapshot == {}


@respx.mock
def test_fetch_snapshot_follows_pagination_across_pages():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
        side_effect=[
            httpx.Response(200, json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 2}),
            httpx.Response(200, json={"rows": [{"id": 0, "cell": _cell("S24067", 2, 1, 0)}], "total": 2}),
        ]
    )

    snapshot = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert set(snapshot.keys()) == {"S24083", "S24067"}
    assert route.call_count == 2


def test_fetch_snapshot_raises_session_expired_when_no_phpsessid_configured():
    ez_collect_mod._cache.clear()
    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(_fetch_ably_io30_snapshot(_setting(sessid=None), "2026-07-30"))


@respx.mock
def test_fetch_snapshot_raises_session_expired_on_login_page_response():
    ez_collect_mod._cache.clear()
    respx.post(_IO30_URL).mock(
        return_value=httpx.Response(200, text="<html><body>login required</body></html>")
    )

    with pytest.raises(EzAdminSessionExpired):
        asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))


@respx.mock
def test_fetch_snapshot_caches_within_ttl_for_same_date():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
        return_value=httpx.Response(
            200, json={"rows": [{"id": 0, "cell": _cell("S24083", 0, 5, 3)}], "total": 1}
        )
    )

    first = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))
    second = asyncio.run(_fetch_ably_io30_snapshot(_setting(), "2026-07-30"))

    assert first == second
    assert route.call_count == 1


@respx.mock
def test_build_ezadmin_collectors_returns_three_columns_from_shared_fetch():
    ez_collect_mod._cache.clear()
    route = respx.post(_IO30_URL).mock(
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

    collectors = build_ezadmin_collectors(_setting())
    assert set(collectors.keys()) == {"stock_qty", "incoming_qty", "ezadmin_lack_qty"}

    stock = asyncio.run(collectors["stock_qty"]("2026-07-30"))
    incoming = asyncio.run(collectors["incoming_qty"]("2026-07-30"))
    lack = asyncio.run(collectors["ezadmin_lack_qty"]("2026-07-30"))

    assert stock == {"S24083": 0, "S24067": 2}
    assert incoming == {"S24083": 5, "S24067": 1}
    assert lack == {"S24083": 3, "S24067": 0}
    assert route.call_count == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ezadmin_collectors.py -v`
Expected: FAIL — `services.order_recommendation_ezadmin_collectors` 모듈이
아직 없어 ImportError.

- [ ] **Step 3: `backend/services/order_recommendation_ezadmin_collectors.py` 구현**

```python
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta

from sdk import config
from sdk.ezadmin import EzAdminClient

_CACHE_TTL_SECONDS = 30
_ABLY_SHOP_CODE = "10028"
_MAX_PAGES = 20
_PAGE_ROWS = 1000

_cache: dict[str, tuple[float, dict[str, dict]]] = {}


def _ez_val(html_value) -> str:
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


def _to_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _io30_par(start_date: str, end_date: str) -> str:
    return (
        "template=IO30&action=&page_code=IO00&search=1&now_page=&is_sort=&"
        "_sort=supply_options&sort_order=1&product_qty_list=&bill_seq=&"
        "offset_top=&work_no=&location_str=&date_type=collect_date&"
        f"start_date={start_date}&start_hour=00%3A00%3A00&"
        f"end_date={end_date}&end_hour=23%3A59%3A59&"
        f"date_period_sel=9&multi_shop_group=&multi_shop=&str_shop_code={_ABLY_SHOP_CODE}&"
        "multi_supply_group=&multi_supply=&str_supply_code=0&"
        "supply_name_search=&brand=&supply_options=&tags_string=&"
        "product_tag_include_type=1&product_id=&name=&options=&"
        "search_keyword_type=origin&search_keyword=&enable_stock_type=2&"
        "order_status=3&except_soldout=1&sel_reserve_qty=none&"
        "sel_return_qty=none&sel_lack_qty=none&sel_req_qty=none&category=0"
    )


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

    client = EzAdminClient(get_setting)
    today = datetime.now()
    start = (today - timedelta(days=90)).strftime("%Y-%m-%d")
    end = today.strftime("%Y-%m-%d")
    par = _io30_par(start, end)
    referer_headers = {"Referer": f"{config.EZADMIN_BASE}/template40.htm?template=IO30"}

    snapshot: dict[str, dict] = {}
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
            cell = row.get("cell", row)
            product_id = _ez_val(cell.get("product_id")).strip()
            if not product_id:
                continue
            snapshot[product_id] = {
                "stock_qty": _to_int(_ez_val(cell.get("stock"))),
                "incoming_qty": _to_int(_ez_val(cell.get("not_yet_deliv"))),
                "ezadmin_lack_qty": _to_int(_ez_val(cell.get("lack_qty"))),
            }

        total_pages = int(data.get("total") or 1)
        if page >= total_pages or page >= _MAX_PAGES:
            break
        page += 1

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

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ezadmin_collectors.py -v`
Expected: PASS (7개 테스트 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/services/order_recommendation_ezadmin_collectors.py backend/tests/test_order_recommendation_ezadmin_collectors.py
git commit -m "feat: add EZAdmin IO30 Ably-channel snapshot fetch and collector builder"
```

---

### Task 3: `/collect` 라우트 — EZAdmin 세션 만료 처리

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Modify: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: `sdk.ezadmin.EzAdminSessionExpired`.
- Produces: `POST /order-recommendation/collect` 응답에 `need_session`
  케이스 추가(기존 성공 응답 형태는 변경 없음).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 상단 import에 추가:

```python
from sdk.ezadmin import EzAdminSessionExpired
```

파일 끝에 추가:

```python
def test_collect_endpoint_returns_need_session_when_ezadmin_session_expired():
    client, _get_db, _keep_alive = _make_client()
    try:
        async def failing_collector(date):
            raise EzAdminSessionExpired()

        collect_mod.register_collector("stock_qty", failing_collector)

        res = client.post("/order-recommendation/collect", params={"date": "2026-07-29"})
        assert res.status_code == 200
        assert res.json() == {"ok": False, "need_session": True}
    finally:
        collect_mod.COLLECTORS.clear()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — `test_collect_endpoint_returns_need_session_when_ezadmin_session_expired`가
처리되지 않은 `EzAdminSessionExpired`로 500 에러를 냄.

- [ ] **Step 3: `backend/api/order_recommendation_routes.py` 수정**

import에 추가:

```python
from sdk.ezadmin import EzAdminSessionExpired
```

`/collect` 라우트를 다음으로 교체:

```python
    @router.post("/collect")
    async def collect(date: str | None = None, user: str = Depends(get_current_user)):
        target_date = date or today_kst()
        try:
            merged = await run_collectors(get_db, target_date)
        except EzAdminSessionExpired:
            return {"ok": False, "need_session": True}
        return {"ok": True, "date": target_date, "updated_codes": sorted(merged.keys())}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS (10개 테스트 전부 — 기존 9개 + 신규 1개)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: return need_session on /collect when EZAdmin session expired"
```

---

### Task 4: `main.py` 배선 — 컬렉터 등록

**Files:**
- Modify: `backend/main.py`

**Interfaces:**
- Consumes: `services.order_recommendation_collect.register_collector`,
  `services.order_recommendation_ezadmin_collectors.build_ezadmin_collectors`.
- Produces: 없음(앱 시작 시 부수효과로 `COLLECTORS`에 3개 등록).

이 태스크는 pytest 대상이 아니라(main.py 와이어링은 기존 라운드들도
`python -c "import main"` 스모크 체크로만 검증해왔다) 실행 확인으로
검증한다.

- [ ] **Step 1: import 추가**

`backend/main.py`의 기존 `from api.order_recommendation_routes import
build_order_recommendation_router` / `from services.order_recommendation_store
import init_order_recommendation_tables` 두 줄(파일 상단, 49~50번째 줄
근처) 바로 다음에 추가:

```python
from services.order_recommendation_collect import register_collector
from services.order_recommendation_ezadmin_collectors import build_ezadmin_collectors
```

- [ ] **Step 2: 컬렉터 등록 코드 추가**

`app.include_router(build_order_recommendation_router(...))` 블록(1423~1429번째
줄 근처, `get_setting=_get_setting,` 포함) 바로 다음 줄에 추가:

```python
for _ez_column, _ez_fn in build_ezadmin_collectors(_get_setting).items():
    register_collector(_ez_column, _ez_fn)
```

(`_get_setting`은 이 지점보다 앞선 1308번째 줄 근처에 이미 정의돼 있어
바로 호출 가능하다 — `init_order_recommendation_tables(_get_shared_db)`가
있는 845번째 줄 근처는 아직 `_get_setting` 정의 전이라 거기 넣으면 안
된다.)

- [ ] **Step 3: 배선 확인**

Run:
```bash
cd backend && python -c "import main; from services.order_recommendation_collect import COLLECTORS; assert set(COLLECTORS.keys()) >= {'stock_qty', 'incoming_qty', 'ezadmin_lack_qty'}; print('registered:', sorted(COLLECTORS.keys()))"
```
Expected: 에러 없이 `registered: [...]` 출력, 목록에 `ezadmin_lack_qty`,
`incoming_qty`, `stock_qty` 포함.

- [ ] **Step 4: 커밋**

```bash
git add backend/main.py
git commit -m "feat: wire EZAdmin Ably-channel collectors into app startup"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/ -k order_recommendation -v` 전체
      PASS (store 15 + calc 37 + collect 5 + routes 10 + evaluate 16 +
      order_performance 13 + ezadmin_collectors 7 = 103개)
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
