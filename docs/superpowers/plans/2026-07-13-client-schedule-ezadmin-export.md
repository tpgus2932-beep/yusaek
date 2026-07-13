# 거래처 일정 — EZAdmin 날짜(C620) 내보내기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the real EZAdmin product code for every 거래처 일정 row so it survives reloads, and add an "EZAdmin 날짜 내보내기" button that pushes rows with a registered schedule date to EZAdmin's `C620` template (상품메모), following the `hywe.py` reference script's exact request shape.

**Architecture:** Two independent slices. (1) DB persistence: add a `product_code` column to `client_schedule_db` (`backend/main.py`), thread it through `GET`/`PUT /client-schedule/db` (`backend/api/collab_routes.py`), and rename the frontend's throwaway `srcI` field to `productCode` so it survives every save/load round-trip. (2) EZAdmin export: a new `POST /barcode/client-schedule/export-to-ezadmin` endpoint in `backend/api/barcode_routes.py` (same file/pattern as the two sibling "EZAdmin 불러오기" endpoints already on this page, called via `LOCAL_API_BASE` — **not** `COLLAB_API_BASE` — because that's where the EZAdmin session cookie lives) builds an `xlwt` workbook (A=상품코드, B=상품메모) from rows the frontend already filtered, and POSTs it to `https://ga80.ezadmin.co.kr/template40.htm?template=C620` exactly like `hywe.py`, parsing the same success regex out of the HTML response.

**Tech Stack:** FastAPI (Python) backend, React (Vite, plain JS/JSX) frontend, `xlwt`/`httpx` (already used elsewhere in `barcode_routes.py`), no test suite in this repo — verification is via `python -m py_compile`, `npm run lint`, manual `curl` against the running dev server, and manual browser exercise.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-client-schedule-ezadmin-export-design.md`
- XLS header row for the export file is exactly `상품코드` (A1) / `상품메모` (B1).
- B열(상품메모) value is the D열(일정) value only — never combine with E열(보조 일정).
- If any row with a non-empty D열(일정) is missing a `productCode`, the export is blocked entirely (no partial export) and the count of blocked rows is shown to the user.
- EZAdmin session-expiry (`need_session`) is only reported when no PHPSESSID is stored at all. A C620 upload whose HTML response doesn't contain the success regex is a generic error, never re-classified as `need_session`.
- The export button lives next to the existing "EZAdmin 불러오기" buttons at the top of the control panel, and requires a `confirm()` before calling the API.
- The new EZAdmin call goes through `LOCAL_API_BASE` (`barcode_routes.py`), not `COLLAB_API_BASE` (`collab_routes.py`) — matches `handleBaseFromEzadmin`/`handleIncomingFromEzadmin` on the same page.
- Follow `hywe.py`'s exact request shape: `POST https://ga80.ezadmin.co.kr/template40.htm?template=C620` with form fields `page=1, action=update2, template=C620, total=0, status=6` and multipart file field `_file`; success is detected via `re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)`.

---

### Task 1: Backend — persist `product_code` on `client_schedule_db`

**Files:**
- Modify: `backend/main.py:964-967` (add migration call)
- Modify: `backend/api/collab_routes.py:1069-1104` (`GET`/`PUT /client-schedule/db`)

**Interfaces:**
- Produces: `client_schedule_db.product_code` column; `GET /client-schedule/db` response items gain a `"productCode"` string field; `PUT /client-schedule/db` accepts and persists a `"productCode"` string field per row (defaults to `""` if absent).

- [ ] **Step 1: Add the column migration in `backend/main.py`**

Find (currently lines 964-967):

```python
_ensure_client_schedule_column(
    "row_i",
    "ALTER TABLE client_schedule_db ADD COLUMN row_i TEXT NOT NULL DEFAULT ''",
)
```

Replace with:

```python
_ensure_client_schedule_column(
    "row_i",
    "ALTER TABLE client_schedule_db ADD COLUMN row_i TEXT NOT NULL DEFAULT ''",
)

_ensure_client_schedule_column(
    "product_code",
    "ALTER TABLE client_schedule_db ADD COLUMN product_code TEXT NOT NULL DEFAULT ''",
)
```

- [ ] **Step 2: Return `productCode` from `GET /client-schedule/db`**

Find in `backend/api/collab_routes.py` (currently lines 1069-1085):

```python
    @router.get("/client-schedule/db")
    def get_client_schedule_db(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,row_i,saved_at FROM client_schedule_db ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        items = [
            {"A": r["row_a"], "B": r["row_b"], "C": r["row_c"],
             "D": r["row_d"], "E": r["row_e"], "F": r["row_f"],
             "G": r["row_g"], "H": r["row_h"], "I": r["row_i"]}
            for r in rows
        ]
        saved_at = rows[-1]["saved_at"] if rows else None
        return {"ok": True, "rows": items, "saved_at": saved_at, "count": len(items)}
```

Replace with:

```python
    @router.get("/client-schedule/db")
    def get_client_schedule_db(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,row_i,product_code,saved_at FROM client_schedule_db ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        items = [
            {"A": r["row_a"], "B": r["row_b"], "C": r["row_c"],
             "D": r["row_d"], "E": r["row_e"], "F": r["row_f"],
             "G": r["row_g"], "H": r["row_h"], "I": r["row_i"],
             "productCode": r["product_code"]}
            for r in rows
        ]
        saved_at = rows[-1]["saved_at"] if rows else None
        return {"ok": True, "rows": items, "saved_at": saved_at, "count": len(items)}
```

- [ ] **Step 3: Accept + persist `productCode` in `PUT /client-schedule/db`**

Find (currently lines 1087-1104):

```python
    @router.put("/client-schedule/db")
    def save_client_schedule_db(payload: dict = Body(...), user: str = Depends(get_current_user)):
        rows = payload.get("rows") or []
        now = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        try:
            conn.execute("DELETE FROM client_schedule_db")
            for row in rows:
                conn.execute(
                    "INSERT INTO client_schedule_db (row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,row_i,saved_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (str(row.get("A","")), str(row.get("B","")), str(row.get("C","")),
                     str(row.get("D","")), str(row.get("E","")), str(row.get("F","")),
                     str(row.get("G","")), str(row.get("H","")), str(row.get("I","")), now),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "saved_at": now, "count": len(rows)}
```

Replace with:

```python
    @router.put("/client-schedule/db")
    def save_client_schedule_db(payload: dict = Body(...), user: str = Depends(get_current_user)):
        rows = payload.get("rows") or []
        now = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        try:
            conn.execute("DELETE FROM client_schedule_db")
            for row in rows:
                conn.execute(
                    "INSERT INTO client_schedule_db (row_a,row_b,row_c,row_d,row_e,row_f,row_g,row_h,row_i,product_code,saved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (str(row.get("A","")), str(row.get("B","")), str(row.get("C","")),
                     str(row.get("D","")), str(row.get("E","")), str(row.get("F","")),
                     str(row.get("G","")), str(row.get("H","")), str(row.get("I","")),
                     str(row.get("productCode","")), now),
                )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "saved_at": now, "count": len(rows)}
```

- [ ] **Step 4: Verify no syntax errors**

Run: `cd backend && python -m py_compile main.py api/collab_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 5: Start the server and verify the migration runs**

```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Expected in logs: server starts with no traceback (migration runs at import time via `_init_client_schedule_db()` / `_ensure_client_schedule_column`).

- [ ] **Step 6: Verify the column round-trips via curl**

With the server running and a valid bearer token (`$TOKEN`):

```bash
curl -s -X PUT http://127.0.0.1:8000/client-schedule/db \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"rows":[{"A":"g","B":"client","C":"detail","D":"2026-07-20","E":"","F":"opt","G":"1","H":"","I":"","productCode":"P12345"}]}'
curl -s http://127.0.0.1:8000/client-schedule/db -H "Authorization: Bearer $TOKEN"
```

Expected: the `GET` response's single row includes `"productCode":"P12345"`.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/api/collab_routes.py
git commit -m "feat: persist product code on client_schedule_db rows"
```

---

### Task 2: Frontend — carry `productCode` through the whole Sheet2 pipeline

**Files:**
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:111` (`preprocessBaseSheet`)
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:372` (`autoSaveToDb` payload)
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:536-537` (`handleSaveToDb` payload)
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:651` (incoming-file match filter)
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:778` (엑셀 업로드 날짜 갱신 payload)

**Interfaces:**
- Consumes: Task 1's `GET`/`PUT /client-schedule/db` now returning/accepting `productCode`.
- Produces: every Sheet2 row object flowing through this file (`preprocessBaseSheet`, `mergeScheduleRows`, `buildSheet1AndSheet2` — both unchanged, already spread `...row`) now carries a stable `productCode` string field that survives DB save/reload. This is what Task 4's export handler reads.

- [ ] **Step 1: Rename `srcI` to `productCode` in `preprocessBaseSheet`**

Find (currently line 111, inside the `sheet2.push({...})` block starting at line 101):

```js
      I: '',
      srcI: toDisplayText(row[8]),
    });
```

Replace with:

```js
      I: '',
      productCode: toDisplayText(row[8]),
    });
```

- [ ] **Step 2: Update the incoming-file match filter to use the new field name**

Find (currently line 651):

```js
        processed = withIds(processed.filter((row) => !incomingKeys.has(toDisplayText(row.srcI))));
```

Replace with:

```js
        processed = withIds(processed.filter((row) => !incomingKeys.has(toDisplayText(row.productCode))));
```

- [ ] **Step 3: Include `productCode` in `autoSaveToDb`'s payload**

Find (currently line 372):

```js
        const payload = rowsToSave.map(({ A, B, C, D, E, F, G, H, I }) => ({ A, B, C, D, E, F, G, H, I }));
```

Replace with:

```js
        const payload = rowsToSave.map(({ A, B, C, D, E, F, G, H, I, productCode }) => ({ A, B, C, D, E, F, G, H, I, productCode }));
```

- [ ] **Step 4: Include `productCode` in `handleSaveToDb`'s payload**

Find (currently lines 535-537):

```js
      const payload = sheet2Rows.map((r) => ({
        A: r.A, B: r.B, C: r.C, D: r.D, E: r.E, F: r.F, G: r.G, H: r.H, I: r.I,
      }));
```

Replace with:

```js
      const payload = sheet2Rows.map((r) => ({
        A: r.A, B: r.B, C: r.C, D: r.D, E: r.E, F: r.F, G: r.G, H: r.H, I: r.I, productCode: r.productCode,
      }));
```

- [ ] **Step 5: Include `productCode` in the 엑셀 업로드 날짜 갱신 payload (`handleDbImport`)**

Find (currently line 778):

```js
      const payload = updated.map(({ A, B, C, D, E, F, G, H, I }) => ({ A, B, C, D, E, F, G, H, I }));
```

Replace with:

```js
      const payload = updated.map(({ A, B, C, D, E, F, G, H, I, productCode }) => ({ A, B, C, D, E, F, G, H, I, productCode }));
```

- [ ] **Step 6: Verify lint passes**

Run: `npm run lint`
Expected: no new errors from `ClientSchedulePage.jsx`.

- [ ] **Step 7: Manual browser verification of persistence**

With `npm run dev` and the backend from Task 1 running:

1. Open 거래처 일정 페이지, load a real 기준 파일 via "EZAdmin 불러오기" (or a local `.xls` file), click "기준 가공 + 병합".
2. Type a date into any row's D열(일정) — this triggers `autoSaveToDb`.
3. Reload the page (fresh `GET /client-schedule/db`).
4. In the browser devtools console, run `document.title` is irrelevant — instead confirm via Network tab that the `GET /client-schedule/db` response for that row includes a non-empty `"productCode"` matching the value it had before reload.

Expected: `productCode` is present after reload (previously it would have been silently dropped).

- [ ] **Step 8: Commit**

```bash
git add src/components/ClientSchedule/ClientSchedulePage.jsx
git commit -m "feat: persist real EZAdmin product code across schedule DB save/load"
```

---

### Task 3: Backend — `POST /barcode/client-schedule/export-to-ezadmin`

**Files:**
- Modify: `backend/api/barcode_routes.py:2413-2415` (insert new route just before `return router`, right after `base_file_from_ezadmin`)

**Interfaces:**
- Consumes: request body `{"rows": [{"productCode": str, "note": str}, ...]}` (built by Task 4's frontend handler; each `note` is the row's D열/일정 value).
- Produces: `{"ok": True, "count": int}` on success; `{"ok": False, "need_session": True}` if no PHPSESSID is stored; `{"ok": False, "error": str, "raw_snippet": str}` if the EZAdmin response doesn't contain the success text; `{"ok": False, "error": str}` on network/request exceptions.

- [ ] **Step 1: Add the endpoint**

Find (currently lines 2413-2415, the end of `base_file_from_ezadmin` and the function's closing `return router`):

```python
        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": 'attachment; filename="base_file.xls"'},
        )

    return router
```

Replace with:

```python
        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": 'attachment; filename="base_file.xls"'},
        )

    @router.post("/barcode/client-schedule/export-to-ezadmin")
    async def client_schedule_export_to_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        import io as _io
        rows = payload.get("rows") or []

        wb = xlwt.Workbook()
        ws = wb.add_sheet("Sheet1")
        ws.write(0, 0, "상품코드")
        ws.write(0, 1, "상품메모")
        for ri, row in enumerate(rows, 1):
            ws.write(ri, 0, str(row.get("productCode", "")))
            ws.write(ri, 1, str(row.get("note", "")))

        buf = _io.BytesIO()
        wb.save(buf)
        xls_bytes = buf.getvalue()

        c620_url = f"{_EZADMIN_BASE}/template40.htm?template=C620"
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        ez_headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Origin": _EZADMIN_BASE,
            "Referer": c620_url,
        }
        cookies = {"PHPSESSID": phpsessid}

        try:
            async with httpx.AsyncClient(timeout=60.0, verify=False, follow_redirects=True) as client:
                r = await client.post(
                    c620_url,
                    data={"page": "1", "action": "update2", "template": "C620", "total": "0", "status": "6"},
                    files={"_file": (f"client_schedule_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
                    cookies=cookies,
                    headers=ez_headers,
                )
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        html = r.text
        m = re.search(r'alert\("(\d+)\s*개 변경 완료 되었습니다\."\)', html)
        if not m:
            return {"ok": False, "error": "응답에서 변경 완료 문구를 찾지 못했습니다", "raw_snippet": html[:300]}
        return {"ok": True, "count": int(m.group(1))}

    return router
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd backend && python -m py_compile api/barcode_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Start the server and verify the route is registered**

```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal:

```bash
curl -s http://127.0.0.1:8000/openapi.json | python -c "import sys,json; d=json.load(sys.stdin); print('/barcode/client-schedule/export-to-ezadmin' in d['paths'])"
```

Expected: `True`.

- [ ] **Step 4: Verify the `need_session` path with a valid bearer token but no stored EZAdmin session**

(Assumes no PHPSESSID has been saved yet in this environment's `app_settings` table.)

```bash
curl -s -X POST http://127.0.0.1:8000/barcode/client-schedule/export-to-ezadmin \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"rows":[{"productCode":"P1","note":"2026-07-20"}]}'
```

Expected: `{"ok":false,"need_session":true}`.

- [ ] **Step 5: Commit**

```bash
git add backend/api/barcode_routes.py
git commit -m "feat: add client-schedule EZAdmin C620 export endpoint"
```

---

### Task 4: Frontend — "EZAdmin 날짜 내보내기" button

**Files:**
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx:846-888` (control panel, add a new export block after the file-selection row)
- Modify: `src/components/ClientSchedule/ClientSchedulePage.jsx` (add `handleExportScheduleToEzadmin` near the other EZAdmin handlers, e.g. right after `handleBaseFromEzadmin`, currently ending at line 624)

**Interfaces:**
- Consumes: Task 2's `row.productCode` field on `sheet2Rows`; Task 3's `POST /barcode/client-schedule/export-to-ezadmin`; existing `openEzadminModal` from `useEzadminSession()` (already destructured at the top of the component); existing `LOCAL_API_BASE` import (already imported at the top of the file).
- Produces: a new `[exportLoading, setExportLoading]` state and `handleExportScheduleToEzadmin` handler; no other task depends on these.

- [ ] **Step 1: Add loading state**

Find (currently line 345, inside the state declarations):

```js
  const [baseEzLoading, setBaseEzLoading] = useState(false);
```

Replace with:

```js
  const [baseEzLoading, setBaseEzLoading] = useState(false);
  const [exportEzLoading, setExportEzLoading] = useState(false);
```

- [ ] **Step 2: Add the handler right after `handleBaseFromEzadmin`**

Find (currently lines 622-625, the end of `handleBaseFromEzadmin`):

```js
    } finally {
      setBaseEzLoading(false);
    }
  };

  const handleBaseProcess = async () => {
```

Replace with:

```js
    } finally {
      setBaseEzLoading(false);
    }
  };

  const handleExportScheduleToEzadmin = async () => {
    const scheduled = sheet2Rows.filter((row) => toDisplayText(row.D));
    if (scheduled.length === 0) {
      setStatus('내보낼 일정이 없습니다.');
      return;
    }

    const missingCode = scheduled.filter((row) => !toDisplayText(row.productCode));
    if (missingCode.length > 0) {
      setStatus(`${missingCode.length}건은 상품코드가 없어 내보낼 수 없습니다. 기준 파일을 다시 불러와 가공해주세요.`);
      return;
    }

    if (!window.confirm(`${scheduled.length}건을 EZAdmin에 반영합니다. 계속할까요?`)) {
      return;
    }

    setExportEzLoading(true);
    try {
      setStatus('EZAdmin에 일정 내보내는 중...');
      const rows = scheduled.map((row) => ({
        productCode: toDisplayText(row.productCode),
        note: toDisplayText(row.D),
      }));
      const res = await fetch(`${LOCAL_API_BASE}/barcode/client-schedule/export-to-ezadmin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleExportScheduleToEzadmin);
        return;
      }
      if (!data?.ok) {
        setStatus(data?.error || 'EZAdmin 날짜 내보내기 실패');
        return;
      }
      setStatus(`EZAdmin 날짜 내보내기 완료 (${data.count ?? 0}건 변경)`);
    } catch (err) {
      setStatus(`EZAdmin 날짜 내보내기 실패: ${err.message || ''}`);
    } finally {
      setExportEzLoading(false);
    }
  };

  const handleBaseProcess = async () => {
```

- [ ] **Step 3: Add the button to the control panel, next to the existing EZAdmin 불러오기 buttons**

Find (currently lines 886-888, the end of the "입고 파일" `fileField` block and the closing of `fileRow`):

```js
              <button
                className={styles.ghostBtn}
                onClick={handleIncomingFromEzadmin}
                disabled={incomingEzLoading}
                style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}
              >
                {incomingEzLoading ? '불러오는 중...' : 'EZAdmin 불러오기'}
              </button>
            </div>
          </div>
```

Replace with:

```js
              <button
                className={styles.ghostBtn}
                onClick={handleIncomingFromEzadmin}
                disabled={incomingEzLoading}
                style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}
              >
                {incomingEzLoading ? '불러오는 중...' : 'EZAdmin 불러오기'}
              </button>
            </div>
            <div className={styles.fileField}>
              <span className={styles.fieldLabel}>일정 반영 <small>(상품메모)</small></span>
              <button
                className={styles.ghostBtn}
                onClick={handleExportScheduleToEzadmin}
                disabled={exportEzLoading || !sheet2Rows.length}
                style={{ fontSize: '0.8rem' }}
              >
                {exportEzLoading ? '내보내는 중...' : 'EZAdmin 날짜 내보내기'}
              </button>
            </div>
          </div>
```

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint`
Expected: no new errors from `ClientSchedulePage.jsx`.

- [ ] **Step 5: Manual browser verification (dry run against real EZAdmin — use a test/known-safe product code first)**

With backend (Task 1 + Task 3) and `npm run dev` running:

1. Open 거래처 일정, process a base file so `sheet2Rows` has real `productCode` values (per Task 2's Step 7).
2. Type a date into one row's D열(일정).
3. Click "EZAdmin 날짜 내보내기".
4. If no EZAdmin session is stored yet, confirm the login modal opens (`need_session` path); paste a valid PHPSESSID and confirm the export automatically retries.
5. Confirm the `window.confirm()` dialog shows the correct row count before sending.
6. After confirming, check the status line shows `EZAdmin 날짜 내보내기 완료 (N건 변경)` and that the "N건" count matches the number of rows with a non-empty D열.
7. Test the blocked path: clear a row's `productCode` is not directly editable from the UI, so instead verify the block by temporarily setting a D열 value on a row your test data doesn't have a product code for (e.g. a manually-typed row with no `productCode`) — confirm the button shows the "N건은 상품코드가 없어..." message and does not call the API (check Network tab for no new request).

Expected: full round trip succeeds end-to-end against a real (or sandboxed) EZAdmin session, and the missing-product-code guard blocks the call with no network request.

- [ ] **Step 6: Commit**

```bash
git add src/components/ClientSchedule/ClientSchedulePage.jsx
git commit -m "feat: add EZAdmin date export button to client schedule page"
```
