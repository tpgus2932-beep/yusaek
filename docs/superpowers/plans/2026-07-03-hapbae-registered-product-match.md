# 합배 구성 선매칭 — 등록상품 매칭 카드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bottom card to the 합배 구성 선매칭 test page (`/test` → `HapbaePreMatch.jsx`) where a user can register wonbe products, and only see them once matched in both the extended order search and the incoming file, with quantity capped at the incoming quantity.

**Architecture:** Backend stores a global registered-products list (same `get_setting`/`set_setting` pattern as the existing `checked_rows` feature) and computes matches inside the existing `GET /barcode/hapbae-pre-match` handler by cross-referencing `state["hapbae_pre_match_rows"]` (per-user extended order search) with `get_shared_incoming_counts()` (shared incoming file counts). Frontend adds a collapsible section reusing the existing `renderTable` helper, with an inline search-and-register control backed by the existing `/wonbe/search` endpoint.

**Tech Stack:** FastAPI (Python) backend, React (Vite) frontend, no test suite in this repo — verification is via `python -m py_compile`, manual `curl` against the running dev server, and manual browser exercise.

## Global Constraints

- Registered-product list is a single **global** setting (not per-user), matching the existing `test_hapbae_checked_rows` policy in `backend/api/barcode_routes.py`.
- A registered product only appears in the UI when it has `orderQty > 0` in the extended order search **and** `incomingQty > 0` in the incoming file. Otherwise it is omitted from the match table entirely (it stays in the registration list).
- Displayed quantity for a matched product = `min(orderQty, incomingQty)` — never exceeds the incoming file quantity.
- Product code matching uses `normalize_to_yusas()` on write (registration) so it lines up with the already-normalized `code` field on `state["hapbae_pre_match_rows"]` entries.
- No shop filtering (`target_shop_key` / "에이블리(유색)") applies to this feature — it matches against all rows in `source_rows` regardless of shop.
- No `window.confirm` on unregister — it's a low-stakes, reversible action (re-registering is one search away).

---

### Task 1: Backend — registered-products storage and CRUD endpoints

**Files:**
- Modify: `backend/api/barcode_routes.py:54` (add setting key)
- Modify: `backend/api/barcode_routes.py:90-100` (add helper functions, right after `_set_hapbae_checked_rows`)
- Modify: `backend/api/barcode_routes.py:1130-1132` (add three new endpoints, right after the existing `PATCH /barcode/hapbae-pre-match/checked` and before `POST /barcode/stock-bulk-fetch`)

**Interfaces:**
- Consumes: `get_setting`, `set_setting` (already injected into `build_barcode_router`, used identically by `_get_hapbae_checked_rows`/`_set_hapbae_checked_rows`); `normalize_to_yusas` (already injected).
- Produces: `_get_registered_products() -> list[dict]` (each `{"code": str, "label": str}`), `_set_registered_products(items: list[dict]) -> list[dict]` — both used by Task 2 and by the endpoints in this task.

- [ ] **Step 1: Add the setting key**

In `backend/api/barcode_routes.py`, find this line (currently line 54):

```python
    hapbae_checked_rows_key = "test_hapbae_checked_rows"
```

Add immediately after it:

```python
    hapbae_registered_products_key = "test_hapbae_registered_products"
```

- [ ] **Step 2: Add the storage helper functions**

Find `_set_hapbae_checked_rows` (currently ends around line 97-100, right before `_parse_dt_hapbae`):

```python
    def _set_hapbae_checked_rows(checked_rows: dict[str, bool]):
        clean = {
            key.strip(): True
            for key, value in checked_rows.items()
            if isinstance(key, str) and key.strip() and value
        }
        set_setting(hapbae_checked_rows_key, json.dumps(clean, ensure_ascii=False))
        return clean

    def _clear_hapbae_checked_rows():
        return _set_hapbae_checked_rows({})
```

Add these two new functions immediately after `_clear_hapbae_checked_rows` and before `_parse_dt_hapbae`:

```python
    def _get_registered_products() -> list[dict]:
        raw = get_setting(hapbae_registered_products_key) or "[]"
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = []
        if not isinstance(parsed, list):
            return []
        clean = []
        seen_codes = set()
        for item in parsed:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").strip()
            label = str(item.get("label") or "").strip()
            if not code or code in seen_codes:
                continue
            seen_codes.add(code)
            clean.append({"code": code, "label": label})
        return clean

    def _set_registered_products(items: list[dict]) -> list[dict]:
        clean = []
        seen_codes = set()
        for item in items:
            code = str(item.get("code") or "").strip()
            label = str(item.get("label") or "").strip()
            if not code or code in seen_codes:
                continue
            seen_codes.add(code)
            clean.append({"code": code, "label": label})
        set_setting(hapbae_registered_products_key, json.dumps(clean, ensure_ascii=False))
        return clean
```

- [ ] **Step 3: Add the three CRUD endpoints**

Find the existing checked-rows PATCH endpoint (currently lines 1119-1130):

```python
    @router.patch("/barcode/hapbae-pre-match/checked")
    def set_hapbae_pre_match_checked(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key = str(payload.get("key") or "").strip()
        if not key:
            raise HTTPException(status_code=400, detail="key required")
        checked = bool(payload.get("checked"))
        checked_rows = _get_hapbae_checked_rows()
        if checked:
            checked_rows[key] = True
        else:
            checked_rows.pop(key, None)
        return {"ok": True, "checked_rows": _set_hapbae_checked_rows(checked_rows)}
```

Add these three endpoints immediately after it, before `@router.post("/barcode/stock-bulk-fetch")`:

```python
    @router.get("/barcode/hapbae-pre-match/registered")
    def get_hapbae_registered_products(user: str = Depends(get_current_user)):
        return {"ok": True, "registered": _get_registered_products()}

    @router.post("/barcode/hapbae-pre-match/registered")
    def add_hapbae_registered_product(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw_code = str(payload.get("code") or "").strip()
        if not raw_code:
            raise HTTPException(status_code=400, detail="code required")
        code = normalize_to_yusas(raw_code) or raw_code
        label = str(payload.get("label") or "").strip()
        current = [item for item in _get_registered_products() if item["code"] != code]
        current.append({"code": code, "label": label})
        return {"ok": True, "registered": _set_registered_products(current)}

    @router.delete("/barcode/hapbae-pre-match/registered")
    def remove_hapbae_registered_product(payload: dict = Body(...), user: str = Depends(get_current_user)):
        code = str(payload.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="code required")
        current = [item for item in _get_registered_products() if item["code"] != code]
        return {"ok": True, "registered": _set_registered_products(current)}
```

- [ ] **Step 4: Verify the file has no syntax errors**

Run: `python -m py_compile backend/api/barcode_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 5: Verify the endpoints are registered and auth-gated**

Start the backend (if not already running):

```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal, run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/barcode/hapbae-pre-match/registered
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/barcode/hapbae-pre-match/registered -H "Content-Type: application/json" -d "{\"code\":\"X\"}"
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://127.0.0.1:8000/barcode/hapbae-pre-match/registered -H "Content-Type: application/json" -d "{\"code\":\"X\"}"
```

Expected: all three print `401` (unauthorized, no token) — confirms the routes exist and are wired to `get_current_user`, rather than `404` (route missing) or `500` (import/syntax error).

- [ ] **Step 6: Commit**

```bash
git add backend/api/barcode_routes.py
git commit -m "feat: add registered-product CRUD endpoints for hapbae pre-match"
```

---

### Task 2: Backend — compute registered-product matches in the main endpoint

**Files:**
- Modify: `backend/api/barcode_routes.py:974-1113` (the `hapbae_pre_match` GET handler)

**Interfaces:**
- Consumes: `_get_registered_products()` (from Task 1), `source_rows`, `incoming_counts`, `to_int` — all already in scope inside `hapbae_pre_match`.
- Produces: `registered_rows` key on the JSON response — a `list[dict]`, each `{"code": str, "productName": str, "optionName": str, "orderQty": int, "incomingQty": int}`, consumed by Task 3/4 on the frontend.

- [ ] **Step 1: Add `registered_rows: []` to the early-return (not-loaded) response**

Find (currently lines 977-985):

```python
        state = get_barcode_state(user)
        if not state.get("loaded"):
            return {
                "ok": True,
                "loaded": False,
                "incoming_loaded": bool(get_shared_incoming_counts()),
                "rows": [],
                "stock_rows": [],
                "stats": {"totalRows": 0, "targetRows": 0, "duplicateRows": 0, "incomingRows": 0, "stockRows": 0},
            }
```

Replace with:

```python
        state = get_barcode_state(user)
        if not state.get("loaded"):
            return {
                "ok": True,
                "loaded": False,
                "incoming_loaded": bool(get_shared_incoming_counts()),
                "rows": [],
                "stock_rows": [],
                "registered_rows": [],
                "stats": {"totalRows": 0, "targetRows": 0, "duplicateRows": 0, "incomingRows": 0, "stockRows": 0},
            }
```

- [ ] **Step 2: Compute `registered_rows` before the final return**

Find the `today_bulk_rows` computation and the final `return` statement (currently lines 1083-1113):

```python
        today_bulk_rows = sorted(
            [
                {
                    **{k: v for k, v in entry.items() if k not in ("_codes", "_max_run_len")},
                    "runLen": entry["_max_run_len"],
                    "incomingQty": sum(int(incoming_counts.get(code, 0) or 0) for code in entry["_codes"]),
                }
                for entry in today_bulk_lookup.values()
                if entry["_max_run_len"] >= 10
                and any(int(incoming_counts.get(code, 0) or 0) >= 10 for code in entry["_codes"])
            ],
            key=lambda r: (-r["orderCount"], _normalize_text(r.get("productName")), _normalize_text(r.get("optionName"))),
        )

        return {
            "ok": True,
            "loaded": True,
            "incoming_loaded": bool(incoming_counts),
            "rows": grouped_rows,
            "stock_rows": grouped_stock_rows,
            "today_bulk_rows": today_bulk_rows,
            "stats": {
                "totalRows": len(source_rows),
                "targetRows": len(target_rows),
                "duplicateRows": len(duplicate_rows),
                "incomingRows": len(result_rows),
                "groupedRows": len(grouped_rows),
                "stockRows": 0,
                "groupedStockRows": len(grouped_stock_rows),
            },
        }
```

Replace with (adds the registered-match computation and the `registered_rows` field on the response):

```python
        today_bulk_rows = sorted(
            [
                {
                    **{k: v for k, v in entry.items() if k not in ("_codes", "_max_run_len")},
                    "runLen": entry["_max_run_len"],
                    "incomingQty": sum(int(incoming_counts.get(code, 0) or 0) for code in entry["_codes"]),
                }
                for entry in today_bulk_lookup.values()
                if entry["_max_run_len"] >= 10
                and any(int(incoming_counts.get(code, 0) or 0) >= 10 for code in entry["_codes"])
            ],
            key=lambda r: (-r["orderCount"], _normalize_text(r.get("productName")), _normalize_text(r.get("optionName"))),
        )

        registered_rows = []
        for item in _get_registered_products():
            code = item.get("code") or ""
            if not code:
                continue
            matches = [row for row in source_rows if (row.get("code") or "") == code]
            order_qty = sum(to_int(row.get("orderQty"), default=0) for row in matches)
            incoming_qty = int(incoming_counts.get(code, 0) or 0)
            if order_qty <= 0 or incoming_qty <= 0:
                continue
            sample = matches[0]
            registered_rows.append({
                "code": code,
                "productName": sample.get("productName", ""),
                "optionName": sample.get("optionName", ""),
                "orderQty": min(order_qty, incoming_qty),
                "incomingQty": incoming_qty,
            })

        return {
            "ok": True,
            "loaded": True,
            "incoming_loaded": bool(incoming_counts),
            "rows": grouped_rows,
            "stock_rows": grouped_stock_rows,
            "today_bulk_rows": today_bulk_rows,
            "registered_rows": registered_rows,
            "stats": {
                "totalRows": len(source_rows),
                "targetRows": len(target_rows),
                "duplicateRows": len(duplicate_rows),
                "incomingRows": len(result_rows),
                "groupedRows": len(grouped_rows),
                "stockRows": 0,
                "groupedStockRows": len(grouped_stock_rows),
            },
        }
```

- [ ] **Step 3: Verify the file has no syntax errors**

Run: `python -m py_compile backend/api/barcode_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual smoke check with a real token**

If you have a valid bearer token for the running backend (log in through the app UI and copy the `token` value from `localStorage`, or from browser devtools Network tab Authorization header), run:

```bash
curl -s http://127.0.0.1:8000/barcode/hapbae-pre-match -H "Authorization: Bearer <token>"
```

Expected: JSON response includes a `"registered_rows"` key (an array — empty is fine if nothing is registered yet or no barcode excel is loaded for this user).

- [ ] **Step 5: Commit**

```bash
git add backend/api/barcode_routes.py
git commit -m "feat: compute registered-product matches in hapbae pre-match response"
```

---

### Task 3: Frontend — data layer (state, load/search/register/unregister)

**Files:**
- Modify: `src/components/Test/HapbaePreMatch.jsx:1-34` (state declarations)
- Modify: `src/components/Test/HapbaePreMatch.jsx:92-129` (`loadRows`, to capture `registered_rows`)
- Modify: `src/components/Test/HapbaePreMatch.jsx:155-157` (mount effect, add `loadRegisteredProducts()`)

**Interfaces:**
- Consumes: `GET /barcode/hapbae-pre-match/registered`, `POST /barcode/hapbae-pre-match/registered`, `DELETE /barcode/hapbae-pre-match/registered` (Task 1); `data.registered_rows` on the `GET /barcode/hapbae-pre-match` response (Task 2); `GET /wonbe/search?q=&limit=` (existing, used identically in `src/components/DBManager/JanggiTable.jsx:190-204`).
- Produces: `registeredProducts` (state, `{code, label}[]`), `registeredMatches` (state, `{code, productName, optionName, orderQty, incomingQty}[]`), `productSearch`/`productResults`/`productSearchLoading` (state), `loadRegisteredProducts()`, `registerProduct(wonbeRow)`, `unregisterProduct(code)` functions — all consumed by Task 4's JSX.

- [ ] **Step 1: Add new state**

Find (currently lines 24-26):

```jsx
  const [expandedSections, setExpandedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hapbae_expanded_sections") || "{}"); } catch { return {}; }
  });
```

Add immediately after it:

```jsx
  const [registeredProducts, setRegisteredProducts] = useState([]);
  const [registeredMatches, setRegisteredMatches] = useState([]);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
```

- [ ] **Step 2: Capture `registered_rows` in `loadRows`**

Find (currently lines 106-111):

```jsx
      setRows(data.rows || []);
      setStockRows(data.stock_rows || []);
      setTodayBulkRows(data.today_bulk_rows || []);
      setStats(data.stats || null);
      setLoaded(!!data.loaded);
      setIncomingLoaded(!!data.incoming_loaded);
```

Replace with:

```jsx
      setRows(data.rows || []);
      setStockRows(data.stock_rows || []);
      setTodayBulkRows(data.today_bulk_rows || []);
      setRegisteredMatches(data.registered_rows || []);
      setStats(data.stats || null);
      setLoaded(!!data.loaded);
      setIncomingLoaded(!!data.incoming_loaded);
```

- [ ] **Step 3: Add `loadRegisteredProducts`, `registerProduct`, `unregisterProduct`**

Find `loadStockBulk` (currently lines 131-153), and add the following three functions immediately after it (before the `useEffect(() => { loadRows(); }, []);` on line 155):

```jsx
  const loadRegisteredProducts = async () => {
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.registered)) setRegisteredProducts(data.registered);
    } catch {
      /* silent - registration list is non-critical */
    }
  };

  const registerProduct = async (wonbeRow) => {
    const code = String(wonbeRow.상품코드 || "").trim();
    if (!code) return;
    const label = [wonbeRow.거래처, wonbeRow.상품명합 || wonbeRow.거래처상품명].filter(Boolean).join(" / ");
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code, label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록 실패");
      setRegisteredProducts(data.registered || []);
      setProductSearch("");
      setProductResults([]);
      loadRows();
    } catch (err) {
      setMessage(err.message || "등록 실패");
    }
  };

  const unregisterProduct = async (code) => {
    try {
      const res = await fetch(`${API}/barcode/hapbae-pre-match/registered`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "등록 해제 실패");
      setRegisteredProducts(data.registered || []);
      loadRows();
    } catch (err) {
      setMessage(err.message || "등록 해제 실패");
    }
  };
```

- [ ] **Step 4: Load registered products on mount, and add the search debounce effect**

Find (currently lines 155-157):

```jsx
  useEffect(() => {
    loadRows();
  }, []);
```

Replace with:

```jsx
  useEffect(() => {
    loadRows();
    loadRegisteredProducts();
  }, []);

  useEffect(() => {
    const q = productSearch.trim();
    if (!q) { setProductResults([]); return; }
    const timer = setTimeout(async () => {
      setProductSearchLoading(true);
      try {
        const params = new URLSearchParams({ q, limit: 20 });
        const res = await fetch(`${API}/wonbe/search?${params}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        setProductResults(data.rows || []);
      } catch {
        setProductResults([]);
      } finally {
        setProductSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [productSearch]);
```

- [ ] **Step 5: Verify no build/lint errors**

Run: `npm run lint`
Expected: no errors reported for `src/components/Test/HapbaePreMatch.jsx` (existing unrelated warnings elsewhere in the repo, if any, are out of scope).

- [ ] **Step 6: Commit**

```bash
git add src/components/Test/HapbaePreMatch.jsx
git commit -m "feat: add registered-product data layer to hapbae pre-match page"
```

---

### Task 4: Frontend — render the "등록상품 매칭" card

**Files:**
- Modify: `src/components/Test/HapbaePreMatch.jsx:2` (icon imports)
- Modify: `src/components/Test/HapbaePreMatch.jsx:461-526` (insert new section after the "TODAY 대량" section, still inside the `<div className={styles.sections}>` wrapper)

**Interfaces:**
- Consumes: `registeredProducts`, `registeredMatches`, `productSearch`, `productResults`, `productSearchLoading`, `registerProduct`, `unregisterProduct`, `setProductSearch` (Task 3); `renderTable(targetRows, sectionKey)`, `isExpanded(key)`, `toggleSection(key)` (already existing in this file, lines 28-34 and 191-232).

- [ ] **Step 1: Add `Star` and `X` icon imports**

Find (currently line 2):

```jsx
import { RefreshCw, TrendingUp, Package, Archive, Zap, Download, ChevronDown, ChevronRight } from "lucide-react";
```

Replace with:

```jsx
import { RefreshCw, TrendingUp, Package, Archive, Zap, Download, ChevronDown, ChevronRight, Star, X } from "lucide-react";
```

- [ ] **Step 2: Insert the new section**

Find the end of the "TODAY 대량" section — the closing `</section>` right before the closing `</div>` of `styles.sections` (currently lines 524-526):

```jsx
          )}
        </section>
      </div>
```

Replace with (adds the new section between the existing closing `</section>` and the `styles.sections` wrapper's closing `</div>`):

```jsx
          )}
        </section>

        <section className={`${styles.section} ${styles.sectionNormal}`}>
          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("registered")}
            style={{ cursor: "pointer" }}
          >
            <div className={styles.sectionTitle}>
              <Star size={15} />
              등록상품 매칭
            </div>
            <div className={styles.sectionMeta}>
              <span>매칭 {registeredMatches.length}건</span>
              <span>등록 {registeredProducts.length}개</span>
              {isExpanded("registered") ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </div>
          </div>
          {isExpanded("registered") && (
            <div style={{ padding: "0.75rem 1rem" }}>
              <div style={{ position: "relative", maxWidth: "360px" }}>
                <input
                  className={styles.searchInput}
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="상품코드/상품명/거래처 검색"
                  style={{ width: "100%" }}
                />
                {productSearch.trim() && (
                  <div
                    style={{
                      position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                      background: "var(--surface, #fff)", border: "1px solid var(--border, #e5e7eb)",
                      borderRadius: "6px", boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
                      maxHeight: "260px", overflowY: "auto", marginTop: "0.25rem",
                    }}
                  >
                    {productSearchLoading ? (
                      <div style={{ padding: "0.6rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>검색 중...</div>
                    ) : productResults.length === 0 ? (
                      <div style={{ padding: "0.6rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>검색 결과가 없습니다.</div>
                    ) : (
                      productResults.map((row, i) => (
                        <div
                          key={i}
                          onClick={() => registerProduct(row)}
                          style={{ padding: "0.5rem 0.6rem", cursor: "pointer", fontSize: "0.8rem", borderBottom: "1px solid var(--border, #f0f0f0)" }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#f5f3ff"}
                          onMouseLeave={(e) => e.currentTarget.style.background = ""}
                        >
                          <strong>{row["거래처합"] ?? row["상품코드"] ?? ""}</strong>
                          <span style={{ marginLeft: "0.4rem", color: "var(--text-muted)" }}>{row["상품명합"] ?? ""}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.75rem" }}>
                {registeredProducts.map((item) => (
                  <span
                    key={item.code}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "0.3rem",
                      padding: "0.2rem 0.5rem", borderRadius: "999px",
                      background: "var(--bg-card, #f3f4f6)", border: "1px solid var(--border, #e5e7eb)",
                      fontSize: "0.78rem",
                    }}
                  >
                    {item.label || item.code}
                    <button
                      type="button"
                      onClick={() => unregisterProduct(item.code)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "var(--text-muted)" }}
                      title="등록 해제"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {!registeredProducts.length && (
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>등록된 상품이 없습니다.</span>
                )}
              </div>

              <div style={{ marginTop: "0.75rem" }}>
                {renderTable(registeredMatches, "registered")}
              </div>
            </div>
          )}
        </section>
      </div>
```

- [ ] **Step 3: Verify no build/lint errors**

Run: `npm run lint`
Expected: no errors reported for `src/components/Test/HapbaePreMatch.jsx`.

- [ ] **Step 4: Manual browser verification**

1. Start both servers:
   ```bash
   cd backend
   uvicorn main:app --reload --host 127.0.0.1 --port 8000
   ```
   ```bash
   npm run dev
   ```
2. Log in to the app, navigate to 사이드메뉴 > 테스트 > 합배 구성 선매칭.
3. Scroll to the bottom — confirm a new "등록상품 매칭" card is visible with badges "매칭 0건" / "등록 0개".
4. Click the card to expand it. Type a known product name/code into the search box — confirm a dropdown appears with results within ~250ms.
5. Click a result — confirm it disappears from the search box, and a chip appears below showing the registered product with an × button.
6. Refresh the page — confirm the chip persists (loaded from `GET /barcode/hapbae-pre-match/registered`).
7. If a barcode 확장주문검색 excel and an 입고파일 are already loaded for the current user with the registered product code present in both, confirm the match table under the chips shows the product with a capped quantity (verify manually that it does not exceed the incoming file's quantity for that code). If no such overlapping data exists, confirm the table shows "조건에 맞는 데이터가 없습니다." (empty state) rather than an error.
8. Click × on the registered chip — confirm it disappears and (if it was showing in the match table) the match table row disappears too.

- [ ] **Step 5: Commit**

```bash
git add src/components/Test/HapbaePreMatch.jsx
git commit -m "feat: render registered-product matching card on hapbae pre-match page"
```
