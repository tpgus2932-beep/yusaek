# External API SDK Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single `backend/sdk/` package that consolidates every external HTTP integration (EZAdmin, Ably, Pastelco, LLogis, Top90) into one client per system, then migrate the first two low-risk call sites onto it to prove the design before the remaining ~19 files are migrated in follow-up plans.

**Architecture:** One client class per external system, each owning its own login/session handling, header construction, and a small set of named high-level operations, plus a generic low-level `request`/`post` escape hatch for operations not yet promoted to a named method. Credentials move to `backend/sdk/config.py`, sourced from environment variables with the current hardcoded values as fallback defaults (so nothing breaks if env vars aren't set yet — moving to a real secret store is future work, not part of this plan).

**Tech Stack:** Python 3.13, `httpx.AsyncClient` (already the only HTTP client used anywhere in this backend), FastAPI (unchanged), no new dependencies.

## Global Constraints

- No automated test suite exists in this repo (confirmed in `CLAUDE.md`). Every task below substitutes a manual verification step (Python import/syntax check, live read-only smoke call, or byte-for-byte diff against the original working code) in place of `pytest`. Final confidence comes from the user exercising the real feature in the running app after deployment — this matches how every other feature in this session has been verified.
- Preserve exact existing request behavior during migration (same form fields, same header values, same timeouts) unless a task explicitly says otherwise. This is a plumbing refactor, not a rewrite — do not "fix" business logic while moving it.
- Two known real bugs were found during the survey (`amood_routes.py:492` hardcodes `"timeFlag": "0"` instead of a real epoch-ms value; `wonbe_routes.py` has a second, independently-hardcoded Top90 login with a different credential set than `services/top90_client.py`). Do **not** silently fix these as a side effect of unrelated tasks — they are out of scope for this plan and are called out explicitly in the backlog so they get a deliberate, reviewed fix later.
- The `my.a-bly.com` vs `seller-admin.a-bly.com` Origin/Referer choice varies per call site with no consistent rule (confirmed by survey). The SDK must accept `origin` as a parameter and each migrated call site must keep using whatever origin the original code used — do not unify to one value.
- New package location: `backend/sdk/` (sibling to `backend/api/` and `backend/services/`), so it's unambiguous that this is "the SDK" referenced in every future file migration.

---

## File Structure

```
backend/sdk/
  __init__.py          # re-exports EzAdminClient, AblyClient, PastelcoClient, LLogisClient, Top90Client, config
  config.py             # all base URLs, credentials (env var + fallback default), session keys
  ezadmin.py            # EzAdminClient: generic post() + named helpers for the invoice-delete flow
  ably.py               # AblyClient: login (with 401 retry) + generic request() + named helpers
  pastelco.py           # PastelcoClient: reuses AblyClient login, one parameterized paginator
  llogis.py             # LLogisClient: covers both pid (return tracking) and trb (accident cargo) hosts
  top90.py              # Top90Client: adapted from backend/services/top90_client.py (logic unchanged)
```

Files modified (pilot migration only — see Task 10-11):
- `backend/services/pastelco_utils.py` — internals rewritten to call `backend/sdk/pastelco.py` and `backend/sdk/ably.py`; public function names/signatures unchanged so its 5 existing importers (`amood_routes.py`, `amood_hapbae.py`, `jeju_hapbae.py`, `ably_minus_routes.py`, `amood_settlement_routes.py`) need zero changes.
- `backend/api/order_routes.py` — its one EZAdmin call site rewritten to use `EzAdminClient`.

---

### Task 1: `backend/sdk/config.py` — centralized constants and credentials

**Files:**
- Create: `backend/sdk/config.py`

**Interfaces:**
- Produces: module-level constants `ABLY_BASE`, `ABLY_EMAIL`, `ABLY_PASSWORD`, `EZADMIN_BASE`, `EZADMIN_SESSION_KEY`, `PASTELCO_BASE`, `LLOGIS_LOGIN_URL`, `LLOGIS_PID_BASE`, `LLOGIS_TRB_BASE`, `LLOGIS_PRINCIPAL`, `LLOGIS_CREDENTIAL`, `LLOGIS_EMP_NO`, `TOP90_BASE`, `TOP90_EMAIL`, `TOP90_PASSWORD` — every later task imports from here instead of redeclaring these.

- [ ] **Step 1: Create the directory and `__init__.py` placeholder**

```bash
mkdir -p backend/sdk
touch backend/sdk/__init__.py
```

- [ ] **Step 2: Write `backend/sdk/config.py`**

```python
"""Centralized configuration for every external API client.

Credentials fall back to the values already hardcoded across the backend
today, so migrating a file to use this module changes nothing at runtime
unless the corresponding environment variable is set. Moving these to a
real secret store is tracked separately — not part of this consolidation.
"""
from __future__ import annotations

import os

# Ably (https://api.a-bly.com) — also used to authenticate Pastelco calls.
ABLY_BASE = "https://api.a-bly.com"
ABLY_EMAIL = os.environ.get("ABLY_EMAIL", "eostm1997@naver.com")
ABLY_PASSWORD = os.environ.get("ABLY_PASSWORD", "!Glqgkqdldi1126")

# EZAdmin (https://ga80.ezadmin.co.kr) — session-cookie auth, no static credential.
EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
EZADMIN_SESSION_KEY = "ezadmin_phpsessid"

# Pastelco (https://api.pastelco.jp) — authenticates via the Ably JWT above.
PASTELCO_BASE = "https://api.pastelco.jp"

# LLogis — one account, two data-domain hosts.
LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_PID_BASE = "https://pid.alps.llogis.com:18210"   # return tracking
LLOGIS_TRB_BASE = "https://trb.alps.llogis.com:18230"   # accident cargo
LLOGIS_PRINCIPAL = os.environ.get("LLOGIS_PRINCIPAL", "348867")
LLOGIS_CREDENTIAL = os.environ.get("LLOGIS_CREDENTIAL", "1q2w3e4r5t")
LLOGIS_EMP_NO = os.environ.get("LLOGIS_EMP_NO", "348867")

# Top90 (https://top90.sosolution.net)
TOP90_BASE = "https://top90.sosolution.net"
TOP90_EMAIL = os.environ.get("TOP90_EMAIL", "")
TOP90_PASSWORD = os.environ.get("TOP90_PASSWORD", "")
```

- [ ] **Step 3: Verify it imports cleanly**

Run: `cd backend && python -c "from sdk import config; print(config.ABLY_BASE, config.EZADMIN_BASE)"`
Expected output: `https://api.a-bly.com https://ga80.ezadmin.co.kr`

- [ ] **Step 4: Commit**

```bash
git add backend/sdk/config.py backend/sdk/__init__.py
git commit -m "sdk: add centralized config module for external API credentials"
```

---

### Task 2: `backend/sdk/ezadmin.py` — `EzAdminClient` core (session, time_flag, session-error detection, generic post)

**Files:**
- Create: `backend/sdk/ezadmin.py`

**Interfaces:**
- Consumes: `backend.sdk.config` (Task 1).
- Produces: `EzAdminSessionExpired` exception; `EzAdminClient(get_setting, timeout=30.0)` with methods `time_flag(mode="browser"|"epoch_ms", now=None) -> str` (staticmethod), `looks_like_session_error(response, body) -> bool` (staticmethod), and `async post(template, action, *, data=None, par=None, files=None, time_flag="browser", extra_headers=None) -> dict`. Later tasks (Task 3, Task 11) call `post()` and the two staticmethods.

- [ ] **Step 1: Write `backend/sdk/ezadmin.py`**

```python
"""EZAdmin (https://ga80.ezadmin.co.kr) client.

Auth is a PHPSESSID cookie, stored by the app under settings key
`config.EZADMIN_SESSION_KEY` and read through an injected `get_setting`
callable (same dependency-injection pattern `main.py` already uses for
every router builder in `backend/api/`).

Reconciles two real inconsistencies found across the 12 files that called
EZAdmin directly before this SDK existed:
  1. `timeFlag` has two valid formats depending on template — a browser
     date string (I100/set_stock_data-style) or a plain epoch-ms integer
     (E900/query_json, packlist_json, cancel_trans, delete_trans_no). Callers
     must pick the right one; there is no way to infer it from the template
     name alone (both patterns appear under different E900 actions).
  2. Session-expiry detection had 3-4 divergent implementations; this one
     is the broadest of the variants found (matches HTML login pages, a
     redirect to a login URL, or any of "login"/"phpsessid"/"session"/"로그인"
     in the response body).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from . import config

_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class EzAdminSessionExpired(Exception):
    """Raised when the stored PHPSESSID is missing or EZAdmin rejected it.

    Callers should catch this and surface `{"ok": False, "need_session": True}`
    to the frontend, matching the existing convention used across every
    EZAdmin-calling route today.
    """


class EzAdminClient:
    def __init__(self, get_setting, *, timeout: float = 30.0):
        self._get_setting = get_setting
        self._timeout = timeout

    def _phpsessid(self) -> str:
        sid = (self._get_setting(config.EZADMIN_SESSION_KEY) or "").strip()
        if not sid:
            raise EzAdminSessionExpired("no PHPSESSID stored in settings")
        return sid

    @staticmethod
    def time_flag(mode: str = "browser", now: datetime | None = None) -> str:
        now = now or datetime.now()
        if mode == "epoch_ms":
            return str(int(now.timestamp() * 1000))
        return (
            f"{_WEEKDAYS[now.weekday()]} {_MONTHS[now.month - 1]} {now.day:02d} "
            f"{now.year} {now:%H:%M:%S} GMT+0900 (한국 표준시)"
        )

    @staticmethod
    def looks_like_session_error(response: httpx.Response, body: str) -> bool:
        lowered = (body or "").lower()
        if response.url and "login" in str(response.url).lower():
            return True
        if "<html" in lowered or "<!doctype html" in lowered:
            return True
        return any(t in lowered for t in ("login", "phpsessid", "session", "로그인"))

    async def post(
        self,
        template: str,
        action: str,
        *,
        data: dict[str, Any] | None = None,
        par: str | None = None,
        files: dict[str, Any] | None = None,
        time_flag: str | None = "browser",
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        """POST to /function.htm. Returns the parsed JSON body.

        `par` is EZAdmin's nested-querystring convention some actions use
        (a single form field whose value is itself `k=v&k2=v2&...`) — pass
        it as one pre-built string, the caller is responsible for encoding
        its sub-values, matching what every existing call site already did.

        Raises `EzAdminSessionExpired` if the PHPSESSID is missing, or if
        the response looks like a login page / isn't valid JSON.
        """
        sid = self._phpsessid()
        form: dict[str, Any] = {"template": template, "action": action}
        if data:
            form.update(data)
        if par is not None:
            form["par"] = par
        if time_flag:
            form.setdefault("timeFlag", self.time_flag(time_flag))

        headers = {
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": f"{config.EZADMIN_BASE}/popup25.htm?template={template}",
            **(extra_headers or {}),
        }
        cookies = {"PHPSESSID": sid}

        async with httpx.AsyncClient(timeout=self._timeout, verify=False, follow_redirects=True) as client:
            if files:
                resp = await client.post(
                    f"{config.EZADMIN_BASE}/function.htm",
                    data=form, files=files, cookies=cookies, headers=headers,
                )
            else:
                resp = await client.post(
                    f"{config.EZADMIN_BASE}/function.htm",
                    data=form, cookies=cookies, headers=headers,
                )

        body = (resp.text or "").strip()
        if self.looks_like_session_error(resp, body):
            raise EzAdminSessionExpired(f"{template}/{action}: session expired or invalid")
        try:
            return resp.json()
        except Exception as exc:
            raise EzAdminSessionExpired(f"{template}/{action}: non-JSON response") from exc
```

- [ ] **Step 2: Verify it imports and `time_flag`/`looks_like_session_error` behave correctly**

Run:
```bash
cd backend && python -c "
from datetime import datetime
from sdk.ezadmin import EzAdminClient
import httpx

now = datetime(2026, 7, 14, 17, 9, 51)
print(EzAdminClient.time_flag('browser', now))
print(EzAdminClient.time_flag('epoch_ms', now))

req = httpx.Request('POST', 'https://ga80.ezadmin.co.kr/function.htm')
resp = httpx.Response(200, request=req, text='{\"rows\": []}')
print(EzAdminClient.looks_like_session_error(resp, resp.text))

resp2 = httpx.Response(200, request=req, text='<html><body>login</body></html>')
print(EzAdminClient.looks_like_session_error(resp2, resp2.text))
"
```
Expected output (4 lines):
```
Tue Jul 14 2026 17:09:51 GMT+0900 (한국 표준시)
1784193000000
False
True
```
(The epoch-ms line will differ if your system timezone isn't UTC+9 — the important checks are line 1's exact string match and lines 3/4 being `False`/`True`.)

- [ ] **Step 3: Commit**

```bash
git add backend/sdk/ezadmin.py
git commit -m "sdk: add EzAdminClient core (session handling, time_flag, generic post)"
```

---

### Task 3: EZAdmin named helpers for the invoice-delete flow

**Files:**
- Modify: `backend/sdk/ezadmin.py`

**Interfaces:**
- Consumes: `EzAdminClient.post` (Task 2).
- Produces: `EzAdminClient.query_orders(super_keyword, *, start_date, end_date, rows=10) -> list[dict]`, `.packlist(pack) -> dict`, `.cancel_trans(seq) -> dict`, `.delete_trans_no(seq) -> dict`, `.set_stock_data(product_id, qty, *, type_="out", bad="0") -> dict`. These are the exact calls already built and manually verified in `backend/api/barcode_routes.py`'s invoice-delete feature this session — copy their request shape verbatim, don't change field names or values.

- [ ] **Step 1: Add the five methods to the end of the `EzAdminClient` class in `backend/sdk/ezadmin.py`**

```python
    async def query_orders(
        self, super_keyword: str, *, start_date: str, end_date: str, rows: int = 10,
    ) -> list[dict]:
        """E900/query_json — search orders by tracking number / free-text keyword.
        Returns the raw `rows` list from the response (each row's `cell.pack`
        is the internal pack id needed by packlist/cancel_trans/delete_trans_no)."""
        par = (
            f"pack=&history_seq=&date_type=collect_date"
            f"&start_date={start_date}&end_date={end_date}"
            f"&date_period_sel=0&search_type=0&keyword="
            f"&keyword1=&keyword2=&keyword3=&keyword4=&keyword5="
            f"&super_keyword={super_keyword}&order_status=-1&order_cs=0"
            f"&query_trans_who=0&is_gift=0&work_type=0"
            f"&labels_string=&checkbox_options_string="
        )
        data = await self.post(
            "E900", "query_json",
            data={"_search": "false", "rows": str(rows), "page": "1", "sidx": "", "sord": "desc", "readonly": "T"},
            par=par, time_flag="epoch_ms",
        )
        return data.get("rows") or []

    async def packlist(self, pack: str) -> dict:
        """E900/packlist_json — product codes + embedded Ably order-item refs for a pack."""
        return await self.post(
            "E900", "packlist_json",
            data={
                "_search": "false", "rows": "500", "page": "1", "sidx": "", "sord": "",
                "readonly": "T", "pack": pack, "stock": "0", "is_masking": "0",
            },
            time_flag="epoch_ms",
        )

    async def cancel_trans(self, seq: str) -> dict:
        """E900/cancel_trans — cancel a shipment transaction."""
        return await self.post(
            "E900", "cancel_trans",
            data={"seq": seq, "content": ""},
            time_flag="epoch_ms",
        )

    async def delete_trans_no(self, seq: str) -> dict:
        """E900/delete_trans_no — delete the invoice/waybill number."""
        return await self.post(
            "E900", "delete_trans_no",
            data={"seq": seq, "content": ""},
            time_flag="epoch_ms",
        )

    async def set_stock_data(
        self, product_id: str, qty: int, *, type_: str = "out", bad: str = "0",
    ) -> dict:
        """I100/set_stock_data — adjust stock for one product code."""
        return await self.post(
            "I100", "set_stock_data",
            data={
                "product_id": product_id, "bad": bad, "type": type_, "stock_label": "",
                "move_warehouse": "0", "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": "",
            },
            time_flag="browser",
        )
```

- [ ] **Step 2: Verify the file still parses and the class has all 6 async methods**

Run:
```bash
cd backend && python -c "
import ast
tree = ast.parse(open('sdk/ezadmin.py', encoding='utf-8').read())
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'EzAdminClient')
methods = [n.name for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
print(methods)
assert {'post', 'query_orders', 'packlist', 'cancel_trans', 'delete_trans_no', 'set_stock_data'} <= set(methods)
print('OK')
"
```
Expected: prints the method list, then `OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/sdk/ezadmin.py
git commit -m "sdk: add EzAdminClient named helpers for order search and invoice-delete flow"
```

---

### Task 4: `backend/sdk/ably.py` — `AblyClient` (login with 401 retry, generic request)

**Files:**
- Create: `backend/sdk/ably.py`

**Interfaces:**
- Consumes: `backend.sdk.config` (Task 1).
- Produces: `AblyClient(timeout=15.0)` with `async login(force=False) -> str`, `headers(token, *, origin="seller-admin.a-bly.com") -> dict`, `async request(method, path, *, json=None, params=None, origin="seller-admin.a-bly.com", timeout=None) -> httpx.Response`. Task 5 and Task 10 build on `request()`.

- [ ] **Step 1: Write `backend/sdk/ably.py`**

```python
"""Ably (https://api.a-bly.com) client.

One JWT login is shared across all Ably *and* Pastelco calls (Pastelco has
no login of its own — it accepts the same Ably-issued JWT, a fact this SDK
makes explicit by having `sdk.pastelco.PastelcoClient` hold an `AblyClient`
instance rather than re-implementing login).

`origin` is a parameter, not a constant: the survey found real EZAdmin/Ably
call sites using both `seller-admin.a-bly.com` and `my.a-bly.com` for
different endpoints with no consistent rule tied to read-vs-write. Each
caller must specify the origin the *original* working code used for that
specific endpoint — do not assume one is universally correct.
"""
from __future__ import annotations

from typing import Any

import httpx

from . import config


class AblyClient:
    def __init__(self, *, timeout: float = 15.0):
        self._timeout = timeout
        self._token: str | None = None

    async def login(self, *, force: bool = False) -> str:
        if self._token and not force:
            return self._token
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.post(
                f"{config.ABLY_BASE}/seller/login/",
                json={"email": config.ABLY_EMAIL, "password": config.ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://seller-admin.a-bly.com",
                    "Referer": "https://seller-admin.a-bly.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
        if not res.is_success:
            raise RuntimeError("에이블리 로그인 실패")
        token = res.json().get("token")
        if not token:
            raise RuntimeError("에이블리 로그인 실패: 토큰 없음")
        self._token = token
        return token

    @staticmethod
    def headers(token: str, *, origin: str = "seller-admin.a-bly.com") -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": f"https://{origin}",
            "Referer": f"https://{origin}/",
            "User-Agent": "Mozilla/5.0",
        }

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict | None = None,
        origin: str = "seller-admin.a-bly.com",
        timeout: float | None = None,
    ) -> httpx.Response:
        """Generic request against api.a-bly.com. Retries once on 401 with a fresh login."""
        token = await self.login()
        async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
            resp = await client.request(
                method, f"{config.ABLY_BASE}{path}",
                headers=self.headers(token, origin=origin), json=json, params=params,
            )
        if resp.status_code == 401:
            token = await self.login(force=True)
            async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
                resp = await client.request(
                    method, f"{config.ABLY_BASE}{path}",
                    headers=self.headers(token, origin=origin), json=json, params=params,
                )
        return resp
```

- [ ] **Step 2: Verify with a live read-only login + goods search (safe — no state change on Ably's side)**

Run:
```bash
cd backend && python -c "
import asyncio
from sdk.ably import AblyClient

async def main():
    client = AblyClient()
    resp = await client.request('POST', '/seller/goods/search/', json={'page': 1, 'per_page': 3})
    data = resp.json()
    print('status:', resp.status_code)
    print('goods returned:', len(data.get('goods', [])))
    print('max_page:', data.get('max_page_number'))

asyncio.run(main())
"
```
Expected: `status: 200`, `goods returned: 3`, and a `max_page` in the low hundreds/thousands (matches the live check already done earlier this session, which returned `max_page: 389` at `per_page=5`).

- [ ] **Step 3: Commit**

```bash
git add backend/sdk/ably.py
git commit -m "sdk: add AblyClient with cached login, 401 retry, and generic request()"
```

---

### Task 5: Ably named helpers used by the invoice-delete flow

**Files:**
- Modify: `backend/sdk/ably.py`

**Interfaces:**
- Consumes: `AblyClient.request` (Task 4).
- Produces: `AblyClient.rollback_order_items_to_prepare(sno_list) -> httpx.Response`, `.search_goods(*, page=1, per_page=30) -> dict`.

- [ ] **Step 1: Add the two methods to the end of the `AblyClient` class in `backend/sdk/ably.py`**

```python
    async def rollback_order_items_to_prepare(self, sno_list: list[int]) -> httpx.Response:
        """PUT /seller/order_items/rollback_to_prepare/ — moves order items back to
        '발송관리' (ready-to-ship) status. Uses my.a-bly.com origin, matching the
        curl this endpoint was captured from (seller-admin.a-bly.com returns 403
        for this specific path — do not change this origin)."""
        return await self.request(
            "PUT", "/seller/order_items/rollback_to_prepare/",
            json={"sno_list": sno_list}, origin="my.a-bly.com",
        )

    async def search_goods(self, *, page: int = 1, per_page: int = 30) -> dict:
        """POST /seller/goods/search/ — paginated goods catalog listing.
        Note: this endpoint ignores any name/keyword filter field (confirmed by
        live testing this session) — it always returns the full catalog page by
        page. Callers needing to find a specific product must paginate through
        results and match client-side."""
        resp = await self.request("POST", "/seller/goods/search/", json={"page": page, "per_page": per_page})
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 2: Verify the file parses and both methods exist**

Run:
```bash
cd backend && python -c "
import ast
tree = ast.parse(open('sdk/ably.py', encoding='utf-8').read())
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'AblyClient')
methods = {n.name for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
assert {'login', 'request', 'rollback_order_items_to_prepare', 'search_goods'} <= methods
print('OK')
"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/sdk/ably.py
git commit -m "sdk: add AblyClient named helpers (rollback_to_prepare, search_goods)"
```

---

### Task 6: `backend/sdk/pastelco.py` — `PastelcoClient` (shares Ably login, merges the two duplicate paginators)

**Files:**
- Create: `backend/sdk/pastelco.py`
- Reference (read, don't modify yet): `backend/services/pastelco_utils.py` — the two functions being merged are `pastelco_fetch_all_orders` and `pastelco_fetch_shipping_processing_today`, which the survey found are near-identical except for a `status` filter and date params.

**Interfaces:**
- Consumes: `AblyClient` (Task 4) — Pastelco authenticates with the same JWT.
- Produces: `PastelcoClient(ably_client=None)` with `async fetch_orders(status, *, today=None) -> list[dict]` (the merged paginator) and `today_kst() -> str` (moved from `pastelco_utils.py` unchanged).

- [ ] **Step 1: Read the two functions being merged**

```bash
grep -n "def pastelco_fetch_all_orders\|def pastelco_fetch_shipping_processing_today\|def pastelco_today_kst" -A 25 backend/services/pastelco_utils.py
```

Confirm both share the same pagination loop shape (page/page_size/total_page) and differ only in the `status` query param and how the date filter is built — this determines the single `status` parameter added below.

- [ ] **Step 2: Write `backend/sdk/pastelco.py`**

```python
"""Pastelco (https://api.pastelco.jp) client.

Pastelco has no login of its own — every request authenticates with the
same JWT issued by Ably's `/seller/login/`. This client therefore wraps an
`AblyClient` instance instead of duplicating login logic.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from . import config
from .ably import AblyClient

_KST = timezone(timedelta(hours=9))


class PastelcoClient:
    def __init__(self, ably_client: AblyClient | None = None):
        self._ably = ably_client or AblyClient()

    @staticmethod
    def today_kst() -> str:
        return datetime.now(_KST).strftime("%Y-%m-%d")

    async def fetch_orders(self, status: str, *, today: str | None = None) -> list[dict]:
        """Paginated order fetch, parameterized by `status`
        (e.g. "SHIPPING_READYING", "SHIPPING_PROCESSING") — replaces the two
        near-identical functions `pastelco_fetch_all_orders` and
        `pastelco_fetch_shipping_processing_today` that existed before this SDK."""
        token = await self._ably.login()
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }
        today = today or self.today_kst()
        all_orders: list[dict] = []
        page = 1
        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                resp = await client.get(
                    f"{config.PASTELCO_BASE}/orders",
                    headers=headers,
                    params={"status": status, "date": today, "page": page, "page_size": 100},
                )
                resp.raise_for_status()
                data = resp.json()
                orders = data.get("orders") or data.get("results") or []
                if not orders:
                    break
                all_orders.extend(orders)
                total_page = data.get("total_page") or data.get("total_pages") or 1
                if page >= total_page:
                    break
                page += 1
        return all_orders
```

- [ ] **Step 3: Cross-check the request shape against the original functions**

```bash
grep -n "PASTELCO_BASE\|params=\|headers=" backend/services/pastelco_utils.py
```

Compare the URL path, query param names, and headers against what you just wrote in `fetch_orders` — adjust `sdk/pastelco.py` to match the *original* exactly (the snippet above is a best-effort reconstruction from the survey; the original file is the source of truth for exact param names). This step matters more than the others in this task — a mismatched param name fails silently (empty results) rather than erroring.

- [ ] **Step 4: Verify it imports**

Run: `cd backend && python -c "from sdk.pastelco import PastelcoClient; print(PastelcoClient.today_kst())"`
Expected: a date string like `2026-07-14`.

- [ ] **Step 5: Commit**

```bash
git add backend/sdk/pastelco.py
git commit -m "sdk: add PastelcoClient, merging the two duplicate order paginators"
```

---

### Task 7: `backend/sdk/llogis.py` — `LLogisClient` (pid + trb hosts, one login)

**Files:**
- Create: `backend/sdk/llogis.py`
- Reference (read, don't modify yet): `backend/api/exchange_return_routes.py` (`_llogis_login`, `_llogis_query_status` around line 80-130) and `backend/api/accident_cargo_routes.py` (the `trb.alps.llogis.com` login/request, to confirm its response shape matches before assuming one login serves both hosts).

**Interfaces:**
- Consumes: `backend.sdk.config` (Task 1).
- Produces: `LLogisClient(timeout=15.0)` with `async login(force=False) -> str`, `async query_return_status(inv_no) -> dict` (pid host), `async query_accident_cargo(...) -> dict` (trb host, signature matched to the original in `accident_cargo_routes.py` during Step 1 below).

- [ ] **Step 1: Read both existing LLogis integrations and confirm the login response shape matches**

```bash
grep -n "_llogis_login\|accessToken\|LLOGIS_LOGIN_URL" -A 15 backend/api/exchange_return_routes.py
grep -n "def.*login\|accessToken\|TRB_BASE" -A 15 backend/api/accident_cargo_routes.py
```

If `accident_cargo_routes.py`'s login call hits the same `LLOGIS_LOGIN_URL` and reads the same `accessToken` field, one shared `login()` is correct — write the client as below. If the response shape differs, stop and write two separate login methods instead (`login()` and `login_trb()`) rather than forcing a shared one — note whichever is true in the class docstring.

- [ ] **Step 2: Write `backend/sdk/llogis.py`** (assuming Step 1 confirms a shared login — adjust per its findings)

```python
"""LLogis client, covering two data-domain hosts under one account:
  - `config.LLOGIS_PID_BASE` (pid.alps.llogis.com:18210) — return tracking lookups.
  - `config.LLOGIS_TRB_BASE` (trb.alps.llogis.com:18230) — accident cargo tracking.

Both were previously implemented as 2 independent copies of login/request
logic (3 files for pid, 1 file for trb) using the same credential pair.
"""
from __future__ import annotations

import json
import time

import httpx

from . import config


class LLogisClient:
    def __init__(self, *, timeout: float = 15.0):
        self._timeout = timeout
        self._token: str | None = None

    async def login(self, *, force: bool = False) -> str:
        if self._token and not force:
            return self._token
        async with httpx.AsyncClient(timeout=self._timeout, verify=False) as client:
            res = await client.post(
                config.LLOGIS_LOGIN_URL,
                json={
                    "principal": config.LLOGIS_PRINCIPAL,
                    "credential": config.LLOGIS_CREDENTIAL,
                    "macAddress": "normal-browser",
                },
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://partner.alps.llogis.com",
                    "Referer": "https://partner.alps.llogis.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
        res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise RuntimeError("llogis 로그인 실패")
        self._token = token
        return token

    async def query_return_status(self, inv_no: str) -> dict:
        """pid host — return/exchange pickup tracking status by invoice number."""
        token = await self.login()
        url = f"{config.LLOGIS_PID_BASE}/pid/ftr/pacltrc/inner/bcraiinvinfo"
        params = {
            "filter": json.dumps({
                "srchInvNo": inv_no, "blngBrshCd": None,
                "empno": config.LLOGIS_EMP_NO, "usrId": config.LLOGIS_EMP_NO,
                "currPageId": "PIDFTR001U", "crdFarePrntStat": "N", "srchOrgInvNo": "",
            }, ensure_ascii=False),
            "_": str(int(time.time() * 1000)),
        }
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0",
        }
        async with httpx.AsyncClient(timeout=self._timeout, verify=False) as client:
            resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 3: Verify it imports**

Run: `cd backend && python -c "from sdk.llogis import LLogisClient; LLogisClient(); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/sdk/llogis.py
git commit -m "sdk: add LLogisClient covering pid (returns) and trb (accident cargo) hosts"
```

---

### Task 8: `backend/sdk/top90.py` — adapt the existing `top90_client.py`

**Files:**
- Create: `backend/sdk/top90.py`
- Reference (read, don't modify): `backend/services/top90_client.py` (228 lines — already well-factored per the survey: single shared session, 401-triggered re-login retry).

**Interfaces:**
- Produces: re-export of the existing client under the SDK namespace so future callers import from one place. Exact method names must match what's already in `backend/services/top90_client.py` — do not rename anything in this task.

- [ ] **Step 1: Read the existing client to get its exact class/function names**

```bash
grep -n "^class \|^def \|^async def " backend/services/top90_client.py
```

- [ ] **Step 2: Write `backend/sdk/top90.py` as a thin re-export**

```python
"""Top90 (https://top90.sosolution.net) client.

The existing implementation in `backend/services/top90_client.py` is
already well-factored (single shared httpx session per lifecycle, 401
retry) — this module re-exports it under the SDK namespace rather than
rewriting it. `backend/api/wonbe_routes.py` currently has a second,
independently hardcoded Top90 login with a *different* credential set
(`values0208@naver.com` vs. this client's env-var-based credentials) —
that divergence is a real bug, tracked in the migration backlog, not
fixed here.
"""
from __future__ import annotations

from services.top90_client import *  # noqa: F401,F403
```

(If `services/top90_client.py` has no `__all__`, replace the wildcard import with explicit names once Step 1's grep output is known — wildcard imports without `__all__` re-export every top-level name, which is acceptable here as a pure pass-through but should be made explicit if the file exports anything unrelated.)

- [ ] **Step 3: Verify it imports and exposes the same names as the original**

Run:
```bash
cd backend && python -c "
import services.top90_client as orig
import sdk.top90 as sdk_top90
orig_names = {n for n in dir(orig) if not n.startswith('_')}
sdk_names = {n for n in dir(sdk_top90) if not n.startswith('_')}
missing = orig_names - sdk_names
print('missing from sdk.top90:', missing)
assert not missing
print('OK')
"
```
Expected: `missing from sdk.top90: set()` then `OK`.

- [ ] **Step 4: Commit**

```bash
git add backend/sdk/top90.py
git commit -m "sdk: re-export existing Top90 client under sdk namespace"
```

---

### Task 9: `backend/sdk/__init__.py` — package entry point

**Files:**
- Modify: `backend/sdk/__init__.py`

**Interfaces:**
- Consumes: Tasks 1-8.
- Produces: `from sdk import EzAdminClient, AblyClient, PastelcoClient, LLogisClient, config` works from any file under `backend/`.

- [ ] **Step 1: Write `backend/sdk/__init__.py`**

```python
"""Consolidated external API SDK for EZAdmin, Ably, Pastelco, LLogis, and Top90.

Usage:
    from sdk import EzAdminClient, AblyClient
    ez = EzAdminClient(get_setting=my_get_setting_fn)
    ably = AblyClient()
"""
from . import config
from .ably import AblyClient
from .ezadmin import EzAdminClient, EzAdminSessionExpired
from .llogis import LLogisClient
from .pastelco import PastelcoClient

__all__ = [
    "config",
    "AblyClient",
    "EzAdminClient",
    "EzAdminSessionExpired",
    "LLogisClient",
    "PastelcoClient",
]
```

Note: `Top90Client` is intentionally left out of this top-level `__all__` — `sdk/top90.py` re-exports whatever `services/top90_client.py` defines, and Task 8 didn't pin down its exact class name. Add it here once Task 8's Step 1 grep confirms the name.

- [ ] **Step 2: Verify the whole package imports cleanly in one shot**

Run: `cd backend && python -c "from sdk import EzAdminClient, AblyClient, PastelcoClient, LLogisClient, config; print('all imports OK')"`
Expected: `all imports OK`

- [ ] **Step 3: Commit**

```bash
git add backend/sdk/__init__.py
git commit -m "sdk: wire up package __init__ exporting all clients"
```

---

### Task 10: Migrate `backend/services/pastelco_utils.py` to the SDK (pilot #1)

**Files:**
- Modify: `backend/services/pastelco_utils.py`

**Interfaces:**
- Consumes: `sdk.pastelco.PastelcoClient`, `sdk.ably.AblyClient` (Tasks 4, 6).
- Produces: unchanged public surface — `pastelco_login()`, `pastelco_today_kst()`, `pastelco_fetch_all_orders(token)`, `pastelco_fetch_shipping_processing_today(token, today=None)` keep their exact existing names and signatures, so `amood_routes.py`, `amood_hapbae.py`, `jeju_hapbae.py`, `ably_minus_routes.py`, and `amood_settlement_routes.py` need **zero** changes in this task.

- [ ] **Step 1: Read the current file in full**

```bash
cat backend/services/pastelco_utils.py
```

- [ ] **Step 2: Rewrite the internals to delegate to the SDK, keeping every public function name and signature identical**

```python
"""Pastelco/Ably shared login and order-fetch helpers.

Thin backward-compatible wrapper around backend/sdk/pastelco.py and
backend/sdk/ably.py — kept so existing callers (amood_routes.py,
amood_hapbae.py, jeju_hapbae.py, ably_minus_routes.py,
amood_settlement_routes.py) don't need to change their imports.
"""
from __future__ import annotations

from sdk.ably import AblyClient
from sdk.pastelco import PastelcoClient

_ably_client = AblyClient()
_pastelco_client = PastelcoClient(ably_client=_ably_client)


async def pastelco_login() -> str:
    return await _ably_client.login()


def pastelco_today_kst() -> str:
    return PastelcoClient.today_kst()


async def pastelco_fetch_all_orders(token: str) -> list[dict]:
    # `token` kept as a parameter for backward compatibility with existing
    # call sites, but ignored — PastelcoClient re-derives it from the shared
    # AblyClient's cached login, which already holds this same token.
    return await _pastelco_client.fetch_orders("SHIPPING_READYING")


async def pastelco_fetch_shipping_processing_today(token: str, today: str | None = None) -> list[dict]:
    return await _pastelco_client.fetch_orders("SHIPPING_PROCESSING", today=today)
```

- [ ] **Step 3: Byte-for-byte compare the original function bodies against Task 6's `PastelcoClient.fetch_orders` to confirm the `status` values (`"SHIPPING_READYING"` / `"SHIPPING_PROCESSING"`) and any other original param actually match**

```bash
git show HEAD~9:backend/services/pastelco_utils.py | grep -n "status\|params="
```
(Adjust `HEAD~9` to whatever commit precedes this task's changes — the goal is diffing against the pre-migration version.) Confirm every literal matches what Task 6 wrote; fix `sdk/pastelco.py` if not, don't silently change behavior here.

- [ ] **Step 4: Verify all 5 existing importers still resolve their imports with no changes needed**

```bash
cd backend && python -c "
import ast, pathlib
for f in ['api/amood_routes.py', 'api/amood_hapbae.py', 'api/jeju_hapbae.py', 'api/ably_minus_routes.py', 'api/amood_settlement_routes.py']:
    src = pathlib.Path(f).read_text(encoding='utf-8')
    ast.parse(src)
    assert 'pastelco_utils' in src, f'{f} no longer imports pastelco_utils?'
print('all 5 importers parse OK and still reference pastelco_utils')
"
```
Expected: `all 5 importers parse OK and still reference pastelco_utils`

- [ ] **Step 5: Manual smoke test — trigger one real feature that goes through this path**

Start the backend (`cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000`) and, from the running frontend, trigger the Jeju Hapbae or Amood Hapbae "불러오기" action (whichever hits `pastelco_fetch_all_orders` per `jeju_hapbae.py`/`amood_hapbae.py`) — confirm it returns the same order list it did before this change. This is the real verification; the steps above only confirm the code is wired correctly, not that Pastelco's API still responds the way `sdk/pastelco.py`'s reconstruction assumed.

- [ ] **Step 6: Commit**

```bash
git add backend/services/pastelco_utils.py
git commit -m "refactor: migrate pastelco_utils.py to use sdk.pastelco/sdk.ably internally"
```

---

### Task 11: Migrate `backend/api/order_routes.py` to the SDK (pilot #2 — EZAdmin path)

**Files:**
- Modify: `backend/api/order_routes.py`

**Interfaces:**
- Consumes: `sdk.ezadmin.EzAdminClient` (Tasks 2-3).
- Produces: same router/endpoint signature as before — this is an internal implementation swap only, the route path and response shape don't change.

- [ ] **Step 1: Read the current file in full**

```bash
cat backend/api/order_routes.py
```

- [ ] **Step 2: Identify its one EZAdmin call site (IO30, per the survey) and note its exact `template`/`action`/`data`/`timeout` values**

```bash
grep -n "template\|action\|timeout\|httpx.AsyncClient" backend/api/order_routes.py
```

- [ ] **Step 3: Replace the inline `httpx.AsyncClient` construction with `EzAdminClient`**

Import at the top of `backend/api/order_routes.py`:
```python
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
```

Where the router builder currently takes `get_setting` as an injected dependency (it already does, per the existing `_EZADMIN_SESSION_KEY` usage found in the survey), construct the client once per-request inside the route handler:
```python
ez = EzAdminClient(get_setting, timeout=60.0)  # 60s matches the original IO30 call's timeout
try:
    data = await ez.post("IO30", "search_IO30", data={...})  # keep the exact original `data` dict contents
except EzAdminSessionExpired:
    return {"ok": False, "need_session": True}
```
Copy the original `data` dict's keys/values exactly as read in Step 2 — do not add, remove, or rename any form field.

- [ ] **Step 4: Remove the now-dead local constants this file no longer needs** (`_EZADMIN_BASE`, `_EZADMIN_SESSION_KEY` if they're not used elsewhere in the same file — grep first to confirm)

```bash
grep -n "_EZADMIN_BASE\|_EZADMIN_SESSION_KEY" backend/api/order_routes.py
```
Only remove a constant if this grep shows zero remaining usages after Step 3's edit.

- [ ] **Step 5: Verify the file parses and the route still registers**

```bash
cd backend && python -c "
import ast
ast.parse(open('api/order_routes.py', encoding='utf-8').read())
print('parses OK')
"
```
Expected: `parses OK`

- [ ] **Step 6: Manual smoke test — trigger the real feature**

Start the backend and, from the Admin > Order page in the frontend, trigger whatever action calls this endpoint (per `CLAUDE.md`'s table, `order_routes` handles "Admin order code registration" at prefix `/order`). Confirm the response matches pre-migration behavior. If it returns `need_session`, re-enter the EZAdmin PHPSESSID via the existing session modal and retry — this confirms the `EzAdminSessionExpired` → `need_session` path works end-to-end.

- [ ] **Step 7: Commit**

```bash
git add backend/api/order_routes.py
git commit -m "refactor: migrate order_routes.py to use sdk.ezadmin.EzAdminClient"
```

---

### Task 12: Final check — full backend import sanity pass

**Files:**
- None modified — verification only.

- [ ] **Step 1: Confirm the whole backend package still imports without error**

```bash
cd backend && python -c "
import ast, pathlib
for f in pathlib.Path('.').rglob('*.py'):
    if '.venv' in f.parts or '__pycache__' in f.parts:
        continue
    ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
print('every .py file under backend/ still parses')
"
```
Expected: `every .py file under backend/ still parses`

- [ ] **Step 2: Start the real server and confirm it boots with no import errors**

```bash
cd backend && timeout 10 uvicorn main:app --host 127.0.0.1 --port 8000 || true
```
Expected: startup log lines with no `ImportError`/`ModuleNotFoundError`/traceback before the 10s timeout kills it (Ctrl+C works too if running interactively).

- [ ] **Step 3: No commit needed for this task** — it's a verification checkpoint confirming Tasks 1-11 didn't break anything else in the backend.

---

## Migration Backlog (not part of this plan — follow-up work once Tasks 1-12 are reviewed and merged)

The pilot above proves the SDK on the 2 smallest/lowest-risk call sites. The remaining 19 files identified in the survey should be migrated incrementally, each as its own small plan/PR (same task shape as Task 10/11 above: read → replace call sites → verify imports → manual smoke test → commit), roughly in this order:

**Small, low-risk (do next):**
- `backend/api/amood_hapbae.py` (1 EZAdmin site)
- `backend/api/inventory_dashboard_routes.py` (1 EZAdmin site)
- `backend/api/jeju_hapbae.py` (EZAdmin + Ably, both via already-migrated `pastelco_utils.py` pattern)
- `backend/api/pastelco_routes.py` (thin wrapper over `pastelco_utils.py`, should need almost no changes)
- `backend/api/amood_settlement_routes.py` (1 Ably/Pastelco login site)
- `backend/services/top90_client.py` consumers — first fix `backend/api/wonbe_routes.py`'s **duplicate, differently-credentialed** Top90 login to import `sdk.top90` instead (this is the real bug flagged in Global Constraints — treat as its own reviewed task, not a drive-by fix)

**Medium (Ably-heavy, several call sites each):**
- `backend/api/noye_kimsungil_routes.py`
- `backend/api/ably_minus_routes.py`
- `backend/collab_app.py`
- `backend/services/amood_settlement_utils.py`
- `backend/services/ably_settlement_utils.py` (note its extra `x-token-type: ably` header — verify with a live call whether it's actually required before dropping it during migration)
- `backend/api/amood_routes.py` (also fix the `"timeFlag": "0"` bug here — flagged in Global Constraints, treat as a reviewed, called-out change)
- `backend/api/wonbe_routes.py` (remaining EZAdmin/Ably sites beyond the Top90 fix above)

**Large, highest-risk (do last, once the SDK has proven itself elsewhere):**
- `backend/api/misong_routes.py`
- `backend/api/return_shipping_routes.py`
- `backend/api/exchange_return_routes.py`
- `backend/api/returns_routes.py`
- `backend/api/accident_cargo_routes.py` (confirm during `sdk/llogis.py`'s Task 7 Step 1 whether it truly shares login with the pid-host files — if not, this file needs its own login path preserved)
- `backend/api/barcode_routes.py` (largest file, 24 call sites, includes the destructive invoice-delete flow built this session — migrate its `EzAdminClient`/`AblyClient` usage last and verify the invoice-delete feature manually end-to-end again after migration, since it's the only flow in this codebase that cancels real transactions and deducts real stock)

Once all 19 are migrated, do a final pass to delete the now-dead duplicated constants (`_EZADMIN_BASE`, `_ABLY_EMAIL`/`_ABLY_PASSWORD`, `_browser_time_flag`, `_looks_like_ezadmin_session_error` and its 3 variant implementations, etc.) from each file — grep for zero remaining usages before deleting, same as Task 11 Step 4.
