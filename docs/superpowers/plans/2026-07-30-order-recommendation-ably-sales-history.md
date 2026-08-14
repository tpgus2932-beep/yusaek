# 추천발주: 에이블리 판매량/장바구니 이력 수집(갭필) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wonbe` 매핑으로 상품코드 ↔ 에이블리 상품번호/옵션번호를 찾아,
최근 28일 중 `order_recommendation_daily.sales_qty`가 비어있는 날짜만
에이블리 판매통계 API로 채운다(장바구니수 포함).

**Architecture:** 신규 `load_wonbe_goods_sno_map()`(`wonbe_routes.py`)이
`{에이블리상품번호: [(옵션번호, 상품코드), ...]}` 매핑을 만든다. 신규
`order_recommendation_ably_sales.py`가 이 매핑으로 goods_sno 그룹을
구성하고, 그룹 내 상품 중 하나라도 비어있는 날짜의 합집합을 goods_sno당
한 번씩 `sdk/ably.py`의 `AblyClient`(JWT 자동 로그인)로 조회해
`sales_qty`/`cart_count`를 채운다. 신규 라우트
`POST /order-recommendation/collect-sales-history`가 이를 실행한다
(동기식, 기존 `order_recommendation_router`에 라우트만 추가 — 별도
main.py 배선 불필요).

**Tech Stack:** FastAPI + SQLite(공유 DB), httpx(`AblyClient` 경유),
pytest + respx.

## Global Constraints

- 백필 깊이는 28일(어제~28일 전, 오늘 자신은 제외) — `calc_weekday_average_sales`의
  `WEEKDAY_MIN_WEEKS=4`를 처음부터 만족시키기 위한 최소 깊이.
- 같은 `goods_sno`를 공유하는 여러 상품코드는 API 호출을 묶는다 —
  옵션(상품코드)마다 따로 호출하지 않는다.
- 이미 `sales_qty`가 채워진 날짜는 다시 조회하지 않는다(갭필).
- `cart_count`는 같이 저장하되 별도 갭 판정은 하지 않는다(그 날짜를
  조회하게 됐을 때 부가로 저장). `like_count`(찜수)는 저장하지 않는다.
- `load_wonbe_goods_sno_map`은 기존 `wonbe_routes.py`의 다른 로더
  함수들과 같은 관례(하드코딩된 `WONBE_DB_PATH`, 별도 단위테스트 없음)를
  따른다 — 새 패턴을 만들지 않는다.
- 기존 `register_collector`/`run_collectors` 프레임워크는 건드리지
  않는다 — 이 컬렉터는 별도 엔드포인트다.

참고 스펙: `docs/superpowers/specs/2026-07-30-order-recommendation-ably-sales-history-design.md`

---

### Task 1: `order_recommendation_ably_sales.py` — 갭필 수집 로직

**Files:**
- Modify: `backend/api/wonbe_routes.py` (매핑 함수 추가, 테스트 없음 —
  이 파일의 기존 로더 함수 관례를 따름)
- Create: `backend/services/order_recommendation_ably_sales.py`
- Test: `backend/tests/test_order_recommendation_ably_sales.py`

**Interfaces:**
- Consumes: `api.wonbe_routes.load_wonbe_goods_sno_map() -> dict[str,
  list[tuple[str, str]]]`. `sdk.ably.AblyClient`(`.request(method, path,
  *, params, origin) -> httpx.Response`, JWT 로그인/401 재시도 자동
  처리). `services.order_recommendation_store.ensure_row`, `today_kst`,
  `get_row`.
- Produces:
  - `_backfill_date_range(as_of_date: str) -> list[str]` — `as_of_date`
    기준 어제~28일 전 날짜 목록.
  - `_missing_dates(conn, yusas_code: str, dates: list[str]) -> list[str]`
  - `_fetch_goods_sno_stats(client: AblyClient, goods_sno: str, date: str) -> list[dict]`
  - `collect_ably_sales_history(get_db) -> int` — 채워진 (날짜,
    상품코드) 개수.

- [ ] **Step 1: `wonbe_routes.py`에 매핑 함수 추가**

`backend/api/wonbe_routes.py`의 `load_wonbe_option_sno_map` 함수
바로 다음(241번째 줄 근처, `load_wonbe_product_cost_map` 정의 앞)에
추가:

```python
def load_wonbe_goods_sno_map() -> dict[str, list[tuple[str, str]]]:
    """에이블리상품번호(goods_sno) → [(옵션번호, 상품코드), ...] 매핑.

    같은 goods_sno 아래 여러 옵션(색상/사이즈 등)이 서로 다른 상품코드로
    관리되는 경우를 그룹으로 묶어, 통계 API를 goods_sno 단위로 한 번만
    호출하면 되도록 한다."""
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        rows = conn.execute(
            "SELECT 상품코드, 옵션번호, 에이블리상품번호 FROM wonbe "
            "WHERE 옵션번호 != '' AND 에이블리상품번호 != ''"
        ).fetchall()
    finally:
        conn.close()
    goods_map: dict[str, list[tuple[str, str]]] = {}
    for r in rows:
        goods_sno = str(r["에이블리상품번호"]).strip()
        option_sno = str(r["옵션번호"]).strip()
        code = r["상품코드"]
        if not goods_sno or not option_sno:
            continue
        goods_map.setdefault(goods_sno, []).append((option_sno, code))
    return goods_map
```

Run: `cd backend && python -c "from api.wonbe_routes import load_wonbe_goods_sno_map; print('OK')"`
Expected: `OK` 출력(문법/임포트 오류 없음 확인용 — 이 함수는 실제 DB
파일에 의존해 단위테스트하지 않는 기존 관례를 따름).

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_ably_sales.py` 생성:

```python
import asyncio
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.ably import AblyClient
from services.order_recommendation_ably_sales import (
    _backfill_date_range,
    _fetch_goods_sno_stats,
    _missing_dates,
    collect_ably_sales_history,
)
from services.order_recommendation_store import (
    ensure_row,
    get_row,
    init_order_recommendation_tables,
    today_kst,
)

_LOGIN_URL = "https://api.a-bly.com/seller/login/"
_STATS_URL = "https://api.a-bly.com/seller/statistics/goods/"


def _make_db_factory():
    uri = f"file:test_order_recommendation_ably_sales_{uuid.uuid4().hex}?mode=memory&cache=shared"
    keep_alive = sqlite3.connect(uri, uri=True)
    keep_alive.row_factory = sqlite3.Row

    def factory():
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    return factory, keep_alive


def _mock_login():
    respx.post(_LOGIN_URL).mock(return_value=httpx.Response(200, json={"token": "test-token"}))


def _goods_option(sno, order_count, cart_count):
    return {"goods_option_sno": sno, "order_count": order_count, "cart_count": cart_count, "like_count": 999}


def _stats_response(goods_options):
    return {
        "results": {
            "statistics": [{"goods_sno": 1, "goods_options": goods_options}] if goods_options is not None else [],
        }
    }


def test_missing_dates_includes_dates_with_no_row():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()

    result = _missing_dates(conn, "S24083", ["2026-07-01", "2026-07-02"])

    assert result == ["2026-07-01", "2026-07-02"]
    conn.close()


def test_missing_dates_includes_dates_with_null_sales_qty():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-01", "S24083")
    conn.commit()

    result = _missing_dates(conn, "S24083", ["2026-07-01"])

    assert result == ["2026-07-01"]
    conn.close()


def test_missing_dates_excludes_dates_already_filled():
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    ensure_row(conn, "2026-07-01", "S24083")
    conn.execute(
        "UPDATE order_recommendation_daily SET sales_qty = 5 WHERE date = ? AND yusas_code = ?",
        ("2026-07-01", "S24083"),
    )
    conn.commit()

    result = _missing_dates(conn, "S24083", ["2026-07-01"])

    assert result == []
    conn.close()


@respx.mock
def test_fetch_goods_sno_stats_parses_goods_options():
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    client = AblyClient()

    options = asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))

    assert options == [_goods_option("111", 5, 2)]


@respx.mock
def test_fetch_goods_sno_stats_returns_empty_list_when_no_statistics():
    _mock_login()
    respx.get(_STATS_URL).mock(return_value=httpx.Response(200, json=_stats_response(None)))
    client = AblyClient()

    options = asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))

    assert options == []


@respx.mock
def test_fetch_goods_sno_stats_raises_on_http_failure():
    _mock_login()
    respx.get(_STATS_URL).mock(return_value=httpx.Response(500, text="server error"))
    client = AblyClient()

    with pytest.raises(RuntimeError):
        asyncio.run(_fetch_goods_sno_stats(client, "1", "2026-07-01"))


@respx.mock
def test_collect_ably_sales_history_fills_shared_group_from_one_call():
    _mock_login()
    stats_route = respx.get(_STATS_URL).mock(
        return_value=httpx.Response(
            200,
            json=_stats_response([
                _goods_option("111", 5, 2),
                _goods_option("222", 3, 1),
            ]),
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083"), ("222", "S24067")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 56  # 28개 날짜 x 2개 상품코드
    assert stats_route.call_count == 28  # goods_sno가 1개뿐이라 날짜당 1번만 호출

    conn = get_db()
    target_date = _backfill_date_range(today_kst())[0]
    row_a = get_row(conn, target_date, "S24083")
    row_b = get_row(conn, target_date, "S24067")
    assert row_a["sales_qty"] == 5
    assert row_a["cart_count"] == 2
    assert row_a["wish_count"] is None
    assert row_b["sales_qty"] == 3
    assert row_b["cart_count"] == 1
    conn.close()


@respx.mock
def test_collect_ably_sales_history_skips_already_filled_dates():
    _mock_login()
    stats_route = respx.get(_STATS_URL).mock(
        return_value=httpx.Response(200, json=_stats_response([_goods_option("111", 5, 2)]))
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)
    conn = get_db()
    all_dates = _backfill_date_range(today_kst())
    for date in all_dates:
        ensure_row(conn, date, "S24083")
        conn.execute(
            "UPDATE order_recommendation_daily SET sales_qty = 99 WHERE date = ? AND yusas_code = ?",
            (date, "S24083"),
        )
    conn.commit()
    conn.close()

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 0
    assert stats_route.call_count == 0


@respx.mock
def test_collect_ably_sales_history_ignores_unmapped_option_sno():
    _mock_login()
    respx.get(_STATS_URL).mock(
        return_value=httpx.Response(
            200,
            json=_stats_response([
                _goods_option("111", 5, 2),
                _goods_option("999", 100, 50),  # 매핑에 없는 옵션
            ]),
        )
    )
    get_db, _keep_alive = _make_db_factory()
    init_order_recommendation_tables(get_db)

    with patch(
        "services.order_recommendation_ably_sales.load_wonbe_goods_sno_map",
        return_value={"1": [("111", "S24083")]},
    ):
        updated = asyncio.run(collect_ably_sales_history(get_db))

    assert updated == 28  # S24083만, 999는 무시
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ably_sales.py -v`
Expected: FAIL — `services.order_recommendation_ably_sales` 모듈이
아직 없어 ImportError.

- [ ] **Step 4: `backend/services/order_recommendation_ably_sales.py` 구현**

```python
from __future__ import annotations

from datetime import datetime, timedelta

from api.wonbe_routes import load_wonbe_goods_sno_map
from sdk.ably import AblyClient
from services.order_recommendation_store import ensure_row, today_kst

BACKFILL_DAYS = 28


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _backfill_date_range(as_of_date: str) -> list[str]:
    return [_date_minus(as_of_date, d) for d in range(1, BACKFILL_DAYS + 1)]


def _missing_dates(conn, yusas_code: str, dates: list[str]) -> list[str]:
    placeholders = ",".join("?" * len(dates))
    rows = conn.execute(
        f"SELECT date, sales_qty FROM order_recommendation_daily "
        f"WHERE yusas_code = ? AND date IN ({placeholders})",
        [yusas_code, *dates],
    ).fetchall()
    filled = {r["date"] for r in rows if r["sales_qty"] is not None}
    return [d for d in dates if d not in filled]


async def _fetch_goods_sno_stats(client: AblyClient, goods_sno: str, date: str) -> list[dict]:
    response = await client.request(
        "GET", "/seller/statistics/goods/",
        params={
            "page": 1, "per_page": 100, "option_enable": "true",
            "keyword": goods_sno, "keyword_type": "goods_sno",
            "start_date": date, "end_date": date,
        },
        origin="my.a-bly.com",
    )
    if not response.is_success:
        raise RuntimeError(
            f"Ably 판매통계 조회 실패 (goods_sno={goods_sno}, date={date}, HTTP {response.status_code})"
        )
    data = response.json()
    statistics = (data.get("results") or {}).get("statistics") or []
    if not statistics:
        return []
    return statistics[0].get("goods_options") or []


async def collect_ably_sales_history(get_db) -> int:
    goods_sno_map = load_wonbe_goods_sno_map()
    dates = _backfill_date_range(today_kst())

    conn = get_db()
    try:
        client = AblyClient()
        updated = 0
        for goods_sno, options in goods_sno_map.items():
            option_to_code = {sno: code for sno, code in options}
            missing: set[str] = set()
            for _sno, yusas_code in options:
                missing.update(_missing_dates(conn, yusas_code, dates))

            for date in sorted(missing):
                goods_options = await _fetch_goods_sno_stats(client, goods_sno, date)
                for opt in goods_options:
                    sno = str(opt.get("goods_option_sno") or "")
                    yusas_code = option_to_code.get(sno)
                    if yusas_code is None:
                        continue
                    ensure_row(conn, date, yusas_code)
                    conn.execute(
                        "UPDATE order_recommendation_daily SET sales_qty = ?, cart_count = ? "
                        "WHERE date = ? AND yusas_code = ?",
                        (int(opt.get("order_count") or 0), int(opt.get("cart_count") or 0), date, yusas_code),
                    )
                    updated += 1
                conn.commit()
    finally:
        conn.close()
    return updated
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_ably_sales.py -v`
Expected: PASS (9개 테스트 전부)

- [ ] **Step 6: 커밋**

```bash
git add backend/api/wonbe_routes.py backend/services/order_recommendation_ably_sales.py backend/tests/test_order_recommendation_ably_sales.py
git commit -m "feat: add Ably sales/cart history gap-fill collector"
```

---

### Task 2: API — `/order-recommendation/collect-sales-history`

**Files:**
- Modify: `backend/api/order_recommendation_routes.py`
- Modify: `backend/tests/test_order_recommendation_routes.py`

**Interfaces:**
- Consumes: `services.order_recommendation_ably_sales.collect_ably_sales_history`.
- Produces: `POST /order-recommendation/collect-sales-history`. 기존
  라우터(`build_order_recommendation_router`)에 라우트만 추가 —
  `main.py` 배선 변경 없음(이미 등록된 라우터라서).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_order_recommendation_routes.py` 상단 import에 추가:

```python
from unittest.mock import AsyncMock, patch
```

파일 끝에 추가:

```python
def test_collect_sales_history_endpoint_returns_updated_count():
    client, _get_db, _keep_alive = _make_client()

    with patch(
        "api.order_recommendation_routes.collect_ably_sales_history",
        new=AsyncMock(return_value=42),
    ):
        res = client.post("/order-recommendation/collect-sales-history")

    assert res.status_code == 200
    assert res.json() == {"ok": True, "updated": 42}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: FAIL — `/collect-sales-history`가 아직 없어 404, 그리고
`patch` 대상 속성이 없어 `AttributeError`.

- [ ] **Step 3: `backend/api/order_recommendation_routes.py` 수정**

import에 추가:

```python
from services.order_recommendation_ably_sales import collect_ably_sales_history
```

`@router.post("/collect")` 라우트 정의 바로 다음, `@router.post("/compute")`
라우트 **앞에** 추가:

```python
    @router.post("/collect-sales-history")
    async def collect_sales_history(user: str = Depends(get_current_user)):
        updated = await collect_ably_sales_history(get_db)
        return {"ok": True, "updated": updated}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_order_recommendation_routes.py -v`
Expected: PASS (11개 테스트 전부 — 기존 10개 + 신규 1개)

- [ ] **Step 5: 커밋**

```bash
git add backend/api/order_recommendation_routes.py backend/tests/test_order_recommendation_routes.py
git commit -m "feat: add collect-sales-history API endpoint"
```

---

## 최종 확인

- [ ] `cd backend && python -m pytest tests/test_order_recommendation_ably_sales.py tests/test_order_recommendation_routes.py -v`
      전체 PASS (9 + 11 = 20개)
- [ ] `cd backend && python -c "import main"` 에러 없음
- [ ] `cd backend && python -m pytest tests/ -q` 전체(회귀 포함) PASS
      — 기존 265개 + 신규 10개(order_recommendation_ably_sales 9 +
      라우트 1) = 275개
