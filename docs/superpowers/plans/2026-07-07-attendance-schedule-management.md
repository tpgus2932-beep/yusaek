# 출퇴근 관리 — 스케줄관리 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th tab "📅 스케줄관리" to `AttendanceAdminPage.jsx` that ports the reference `yusaek-schedule-app` prototype's weekly/monthly work-schedule planner, backed by real server DB storage and the existing `attendance_members` employee list.

**Architecture:** Three new SQLite tables (`attendance_schedule_fixed_rules`, `attendance_schedule_overrides`, `attendance_schedule_memos`) added to `backend/api/attendance_routes.py`, reusing the existing PIN-check helper and `attendance_members` table. A new `GET /attendance/schedule` combined-read endpoint plus upsert/delete endpoints for each entity, all requiring `pin` (matching the existing `records`/`salary` tab convention). Frontend: a new self-contained `ScheduleTab.jsx` component (+ its own CSS module), receiving `pin` and `members` as props from `AttendanceAdminPage.jsx`, calling the new endpoints instead of `localStorage`.

**Tech Stack:** FastAPI (Python) backend, React (Vite, plain JS/JSX) frontend, `date-fns` (already installed), no test suite in this repo — verification is via `python -m py_compile`, `npm run lint`, manual `curl` against the running dev server, and manual browser exercise.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-attendance-schedule-management-design.md`
- Employee identity is `attendance_members.id` (integer) — no separate employee list for schedules.
- All new endpoints live in `backend/api/attendance_routes.py` (no new router file) and require `pin` via the existing `_check_pin(pin)` helper.
- Every write endpoint returns the **full, updated list** of that entity type (not just the changed row) — the frontend always replaces its whole state array from the response, never merges locally. This avoids client/server divergence bugs.
- JSON field names are camelCase (`memberId`, `startTime`, `endTime`, `effectiveFrom`, `weekday`, `status`, `date`, `content`) even though SQLite columns are snake_case — matches the existing convention elsewhere in this backend (e.g. `barcode_routes.py` returns `productName`/`orderQty` from snake_case-ish internals).
- Weekly 15-hour cap is enforced both client-side (immediate UX feedback, ported from the reference app) and server-side (defense in depth, new). Server-side validation deliberately does **not** account for Korean holidays (that table only exists client-side for display) — this makes the server marginally stricter on the ~15 holiday dates/year where a client would show 0h for a "scheduled" fixed-rule day; that's an accepted, documented tradeoff to avoid duplicating a 5-year hardcoded holiday table in Python.
- No `alert()`/`window.confirm()` in the new component — errors show in an inline message area, matching the rest of `AttendanceAdminPage.jsx`.
- The reference app's own employee-management panel (`showEmployeeManager`, add/edit/delete employee) is **not** ported — `attendance_members` is managed exclusively from the existing "직원 관리" tab.

---

### Task 1: Backend — schema + member-delete cascade

**Files:**
- Modify: `backend/api/attendance_routes.py:14-42` (`_init()` function)
- Modify: `backend/api/attendance_routes.py:148-155` (`delete_member`)

**Interfaces:**
- Produces: three new SQLite tables, queryable by later tasks via `get_db()` (already injected into `build_attendance_router`).

- [ ] **Step 1: Add the three new tables + indexes to `_init()`**

Find (currently lines 36-39):

```python
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_att_rec_date ON attendance_records(date)"
        )
        conn.commit()
        conn.close()
```

Replace with:

```python
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_att_rec_date ON attendance_records(date)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_fixed_rules (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id      INTEGER NOT NULL,
                weekday        INTEGER NOT NULL,
                start_time     TEXT NOT NULL,
                end_time       TEXT NOT NULL,
                effective_from TEXT NOT NULL,
                status         TEXT NOT NULL,
                created_at     TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_fixed_member ON attendance_schedule_fixed_rules(member_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_overrides (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id  INTEGER NOT NULL,
                date       TEXT NOT NULL,
                weekday    INTEGER NOT NULL,
                start_time TEXT NOT NULL,
                end_time   TEXT NOT NULL,
                status     TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(member_id, date)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_override_member ON attendance_schedule_overrides(member_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_memos (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id  INTEGER NOT NULL,
                date       TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(member_id, date)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_memo_member ON attendance_schedule_memos(member_id)"
        )
        conn.commit()
        conn.close()
```

- [ ] **Step 2: Cascade-delete schedule data when a member is deleted**

Find (currently lines 148-155):

```python
    # ── 직원 삭제 (PIN 필요) ────────────────────────────
    @router.delete("/members/{member_id}")
    def delete_member(member_id: int, body: MemberDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute("DELETE FROM attendance_members WHERE id = ?", (member_id,))
        conn.commit()
        conn.close()
        return {"ok": True}
```

Replace with:

```python
    # ── 직원 삭제 (PIN 필요) ────────────────────────────
    @router.delete("/members/{member_id}")
    def delete_member(member_id: int, body: MemberDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute("DELETE FROM attendance_members WHERE id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_fixed_rules WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_overrides WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_memos WHERE member_id = ?", (member_id,))
        conn.commit()
        conn.close()
        return {"ok": True}
```

- [ ] **Step 3: Verify no syntax errors**

Run: `python -m py_compile backend/api/attendance_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify the tables get created**

Delete or rename any stale local `backend/app.db` only if you're certain no one else needs its data — otherwise just start the server, which runs `_init()` on import:

```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal:

```bash
python -c "import sqlite3; c = sqlite3.connect('backend/app.db'); print(sorted(r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'attendance_schedule%'\")))"
```

Expected: `['attendance_schedule_fixed_rules', 'attendance_schedule_memos', 'attendance_schedule_overrides']`

- [ ] **Step 5: Commit**

```bash
git add backend/api/attendance_routes.py
git commit -m "feat: add schedule tables and member-delete cascade"
```

---

### Task 2: Backend — combined read endpoint

**Files:**
- Modify: `backend/api/attendance_routes.py` (add helpers + endpoint after the `PinChange` model / before `# ── 직원 목록` section, or anywhere inside `build_attendance_router` before `return router`)

**Interfaces:**
- Produces: `_fixed_rule_row_to_dict`, `_override_row_to_dict`, `_memo_row_to_dict` (row → camelCase dict), `GET /attendance/schedule?pin=` → `{fixedRules: [...], overrides: [...], memos: [...]}`. Consumed by Tasks 3-5 (row-to-dict helpers) and by the frontend (Task 7).

- [ ] **Step 1: Add the row-to-dict helpers and the read endpoint**

Find the end of the router, currently:

```python
    # ── PIN 변경 ────────────────────────────────────────
    @router.post("/change-pin")
    def change_pin(body: PinChange):
        _check_pin(body.old_pin)
        new_pin = body.new_pin.strip()
        if not new_pin:
            raise HTTPException(status_code=400, detail="새 PIN을 입력하세요.")
        set_setting(ATTENDANCE_ADMIN_PIN_KEY, hash_pin(new_pin))
        return {"ok": True}

    return router
```

Replace with (adds a new section before `return router`):

```python
    # ── PIN 변경 ────────────────────────────────────────
    @router.post("/change-pin")
    def change_pin(body: PinChange):
        _check_pin(body.old_pin)
        new_pin = body.new_pin.strip()
        if not new_pin:
            raise HTTPException(status_code=400, detail="새 PIN을 입력하세요.")
        set_setting(ATTENDANCE_ADMIN_PIN_KEY, hash_pin(new_pin))
        return {"ok": True}

    # ── 스케줄관리 ──────────────────────────────────────

    def _fixed_rule_row_to_dict(r):
        return {
            "id": r["id"], "memberId": r["member_id"], "weekday": r["weekday"],
            "startTime": r["start_time"], "endTime": r["end_time"],
            "effectiveFrom": r["effective_from"], "status": r["status"],
        }

    def _override_row_to_dict(r):
        return {
            "id": r["id"], "memberId": r["member_id"], "weekday": r["weekday"],
            "date": r["date"], "startTime": r["start_time"], "endTime": r["end_time"],
            "status": r["status"],
        }

    def _memo_row_to_dict(r):
        return {"id": r["id"], "memberId": r["member_id"], "date": r["date"], "content": r["content"]}

    @router.get("/schedule")
    def get_schedule(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        fixed_rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        override_rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        memo_rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {
            "fixedRules": [_fixed_rule_row_to_dict(r) for r in fixed_rows],
            "overrides": [_override_row_to_dict(r) for r in override_rows],
            "memos": [_memo_row_to_dict(r) for r in memo_rows],
        }

    return router
```

- [ ] **Step 2: Verify no syntax errors**

Run: `python -m py_compile backend/api/attendance_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual smoke check**

With the backend running (`uvicorn main:app --reload --host 127.0.0.1 --port 8000` from `backend/`):

```bash
curl -s "http://127.0.0.1:8000/attendance/schedule?pin=1234"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8000/attendance/schedule?pin=wrong"
```

Expected: first call prints `{"fixedRules":[],"overrides":[],"memos":[]}` (empty arrays on a fresh DB); second call prints `403`.

- [ ] **Step 4: Commit**

```bash
git add backend/api/attendance_routes.py
git commit -m "feat: add GET /attendance/schedule combined read endpoint"
```

---

### Task 3: Backend — fixed-rules bulk write endpoint

**Files:**
- Modify: `backend/api/attendance_routes.py` (add Pydantic model + endpoint, right after the code added in Task 2, before `return router`)

**Interfaces:**
- Consumes: `_fixed_rule_row_to_dict` (Task 2), `_check_pin`, `get_db`, `_now_kst` (all already in scope).
- Produces: `POST /attendance/schedule/fixed-rules/bulk` → `{ok: true, fixedRules: [...]}`. Consumed by frontend Task 7.

- [ ] **Step 1: Add the hour-math helper, Pydantic model, and endpoint**

Find (currently the end of the file, after Task 2's additions):

```python
    @router.get("/schedule")
    def get_schedule(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        fixed_rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        override_rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        memo_rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {
            "fixedRules": [_fixed_rule_row_to_dict(r) for r in fixed_rows],
            "overrides": [_override_row_to_dict(r) for r in override_rows],
            "memos": [_memo_row_to_dict(r) for r in memo_rows],
        }

    return router
```

Replace with:

```python
    @router.get("/schedule")
    def get_schedule(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        fixed_rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        override_rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        memo_rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {
            "fixedRules": [_fixed_rule_row_to_dict(r) for r in fixed_rows],
            "overrides": [_override_row_to_dict(r) for r in override_rows],
            "memos": [_memo_row_to_dict(r) for r in memo_rows],
        }

    def _hours_between(start: str, end: str) -> float:
        sh, sm = (int(x) for x in start.split(":"))
        eh, em = (int(x) for x in end.split(":"))
        return (eh + em / 60) - (sh + sm / 60)

    class ScheduleFixedRuleItem(BaseModel):
        weekday: int
        startTime: str
        endTime: str
        status: str

    class ScheduleFixedRulesBulkCreate(BaseModel):
        pin: str
        memberId: int
        effectiveFrom: str
        rules: list[ScheduleFixedRuleItem]

    @router.post("/schedule/fixed-rules/bulk")
    def add_schedule_fixed_rules_bulk(body: ScheduleFixedRulesBulkCreate):
        _check_pin(body.pin)
        if not body.rules:
            raise HTTPException(status_code=400, detail="rules가 비어있습니다.")
        for item in body.rules:
            if item.status == "scheduled" and _hours_between(item.startTime, item.endTime) <= 0:
                raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 늦어야 합니다.")
        total_hours = sum(
            _hours_between(item.startTime, item.endTime)
            for item in body.rules if item.status == "scheduled"
        )
        if total_hours > 15:
            raise HTTPException(status_code=400, detail="직원별 주 15시간을 초과할 수 없습니다.")

        conn = get_db()
        now = _now_kst().isoformat()
        conn.executemany(
            "INSERT INTO attendance_schedule_fixed_rules "
            "(member_id, weekday, start_time, end_time, effective_from, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (body.memberId, item.weekday, item.startTime, item.endTime, body.effectiveFrom, item.status, now)
                for item in body.rules
            ],
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "fixedRules": [_fixed_rule_row_to_dict(r) for r in rows]}

    return router
```

- [ ] **Step 2: Verify no syntax errors**

Run: `python -m py_compile backend/api/attendance_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual smoke check**

With the backend running and at least one member already registered (add one via the app's 직원 관리 tab, or `curl -X POST http://127.0.0.1:8000/attendance/members -H "Content-Type: application/json" -d "{\"name\":\"테스트직원\",\"pin\":\"1234\"}"`), find its id:

```bash
curl -s http://127.0.0.1:8000/attendance/members
```

Then (replace `1` with the real id):

```bash
curl -s -X POST http://127.0.0.1:8000/attendance/schedule/fixed-rules/bulk \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"effectiveFrom\":\"2026-07-06\",\"rules\":[{\"weekday\":1,\"startTime\":\"09:00\",\"endTime\":\"14:00\",\"status\":\"scheduled\"},{\"weekday\":2,\"startTime\":\"09:00\",\"endTime\":\"14:00\",\"status\":\"none\"},{\"weekday\":3,\"startTime\":\"09:00\",\"endTime\":\"14:00\",\"status\":\"none\"},{\"weekday\":4,\"startTime\":\"09:00\",\"endTime\":\"14:00\",\"status\":\"none\"},{\"weekday\":5,\"startTime\":\"09:00\",\"endTime\":\"14:00\",\"status\":\"none\"}]}"
```

Expected: `{"ok":true,"fixedRules":[{"id":1,"memberId":1,"weekday":1,"startTime":"09:00","endTime":"14:00","effectiveFrom":"2026-07-06","status":"scheduled"}, ...4 more rows...]}`

Then verify the 15h cap rejects an overloaded week (5 days × 4h = 20h > 15h, all `"status":"scheduled"`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/attendance/schedule/fixed-rules/bulk \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"effectiveFrom\":\"2026-07-06\",\"rules\":[{\"weekday\":1,\"startTime\":\"09:00\",\"endTime\":\"13:00\",\"status\":\"scheduled\"},{\"weekday\":2,\"startTime\":\"09:00\",\"endTime\":\"13:00\",\"status\":\"scheduled\"},{\"weekday\":3,\"startTime\":\"09:00\",\"endTime\":\"13:00\",\"status\":\"scheduled\"},{\"weekday\":4,\"startTime\":\"09:00\",\"endTime\":\"13:00\",\"status\":\"scheduled\"},{\"weekday\":5,\"startTime\":\"09:00\",\"endTime\":\"13:00\",\"status\":\"scheduled\"}]}"
```

Expected: `400`

- [ ] **Step 4: Commit**

```bash
git add backend/api/attendance_routes.py
git commit -m "feat: add fixed-rules bulk write endpoint with weekly hour cap"
```

---

### Task 4: Backend — overrides upsert/delete endpoints

**Files:**
- Modify: `backend/api/attendance_routes.py` (add helper + Pydantic models + two endpoints, right after Task 3's addition, before `return router`)

**Interfaces:**
- Consumes: `_override_row_to_dict`, `_hours_between` (Task 2/3).
- Produces: `POST /attendance/schedule/overrides` and `DELETE /attendance/schedule/overrides`, both → `{ok: true, overrides: [...]}`.

- [ ] **Step 1: Add the week-hours helper and both endpoints**

Find the end of Task 3's addition:

```python
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "fixedRules": [_fixed_rule_row_to_dict(r) for r in rows]}

    return router
```

Replace with:

```python
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "fixedRules": [_fixed_rule_row_to_dict(r) for r in rows]}

    def _member_week_hours(conn, member_id: int, date_str: str, pending: dict | None = None) -> float:
        """date_str가 속한 월~금 주간의 예정 근무시간 합계.
        pending이 있으면 그 날짜의 override는 DB 값 대신 pending 값으로 계산한다
        (저장 전 검증용 — 공휴일은 고려하지 않는다, Global Constraints 참고)."""
        d = datetime.strptime(date_str, "%Y-%m-%d")
        monday = d - timedelta(days=d.weekday())
        week_dates = [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]

        placeholders = ",".join("?" * len(week_dates))
        existing_overrides = {
            r["date"]: r
            for r in conn.execute(
                f"SELECT date, start_time, end_time, status FROM attendance_schedule_overrides "
                f"WHERE member_id = ? AND date IN ({placeholders})",
                (member_id, *week_dates),
            ).fetchall()
        }
        fixed_rules = conn.execute(
            "SELECT weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules WHERE member_id = ? "
            "ORDER BY effective_from DESC, id DESC",
            (member_id,),
        ).fetchall()

        def fixed_for(weekday, on_date):
            for r in fixed_rules:
                if r["weekday"] == weekday and r["status"] == "scheduled" and r["effective_from"] <= on_date:
                    return r
            return None

        total = 0.0
        for i, wd_date in enumerate(week_dates):
            weekday = i + 1
            if pending and pending["date"] == wd_date:
                if pending["status"] == "scheduled":
                    total += _hours_between(pending["start_time"], pending["end_time"])
                continue
            override = existing_overrides.get(wd_date)
            if override:
                if override["status"] == "scheduled":
                    total += _hours_between(override["start_time"], override["end_time"])
                continue
            rule = fixed_for(weekday, wd_date)
            if rule:
                total += _hours_between(rule["start_time"], rule["end_time"])
        return total

    class ScheduleOverrideUpsert(BaseModel):
        pin: str
        memberId: int
        weekday: int
        date: str
        startTime: str
        endTime: str
        status: str

    class ScheduleOverrideDelete(BaseModel):
        pin: str
        memberId: int
        date: str

    @router.post("/schedule/overrides")
    def upsert_schedule_override(body: ScheduleOverrideUpsert):
        _check_pin(body.pin)
        if body.status == "scheduled" and _hours_between(body.startTime, body.endTime) <= 0:
            raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 늦어야 합니다.")

        conn = get_db()
        if body.status == "scheduled":
            pending = {
                "date": body.date, "status": body.status,
                "start_time": body.startTime, "end_time": body.endTime,
            }
            total_hours = _member_week_hours(conn, body.memberId, body.date, pending)
            if total_hours > 15:
                conn.close()
                raise HTTPException(status_code=400, detail="직원별 주 15시간을 초과할 수 없습니다.")

        conn.execute(
            "INSERT INTO attendance_schedule_overrides "
            "(member_id, weekday, date, start_time, end_time, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(member_id, date) DO UPDATE SET "
            "weekday = excluded.weekday, start_time = excluded.start_time, "
            "end_time = excluded.end_time, status = excluded.status",
            (body.memberId, body.weekday, body.date, body.startTime, body.endTime, body.status, _now_kst().isoformat()),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    @router.delete("/schedule/overrides")
    def delete_schedule_override(body: ScheduleOverrideDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute(
            "DELETE FROM attendance_schedule_overrides WHERE member_id = ? AND date = ?",
            (body.memberId, body.date),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    return router
```

- [ ] **Step 2: Verify no syntax errors**

Run: `python -m py_compile backend/api/attendance_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual smoke check**

Using the same `memberId=1` from Task 3 (which now has Monday 09:00-14:00 scheduled):

```bash
curl -s -X POST http://127.0.0.1:8000/attendance/schedule/overrides \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"weekday\":1,\"date\":\"2026-07-06\",\"startTime\":\"10:00\",\"endTime\":\"15:00\",\"status\":\"scheduled\"}"
```

Expected: `{"ok":true,"overrides":[{"id":1,"memberId":1,"weekday":1,"date":"2026-07-06","startTime":"10:00","endTime":"15:00","status":"scheduled"}]}`

```bash
curl -s -X DELETE http://127.0.0.1:8000/attendance/schedule/overrides \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"date\":\"2026-07-06\"}"
```

Expected: `{"ok":true,"overrides":[]}`

- [ ] **Step 4: Commit**

```bash
git add backend/api/attendance_routes.py
git commit -m "feat: add schedule override upsert/delete endpoints with weekly hour cap"
```

---

### Task 5: Backend — memo upsert/delete endpoints

**Files:**
- Modify: `backend/api/attendance_routes.py` (add Pydantic models + two endpoints, right after Task 4's addition, before `return router`)

**Interfaces:**
- Consumes: `_memo_row_to_dict` (Task 2).
- Produces: `POST /attendance/schedule/memos` and `DELETE /attendance/schedule/memos`, both → `{ok: true, memos: [...]}`.

- [ ] **Step 1: Add the Pydantic models and endpoints**

Find the end of Task 4's addition:

```python
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    return router
```

Replace with:

```python
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    class ScheduleMemoUpsert(BaseModel):
        pin: str
        memberId: int
        date: str
        content: str

    class ScheduleMemoDelete(BaseModel):
        pin: str
        memberId: int
        date: str

    @router.post("/schedule/memos")
    def upsert_schedule_memo(body: ScheduleMemoUpsert):
        _check_pin(body.pin)
        conn = get_db()
        content = body.content.strip()
        if content:
            conn.execute(
                "INSERT INTO attendance_schedule_memos (member_id, date, content, created_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(member_id, date) DO UPDATE SET content = excluded.content",
                (body.memberId, body.date, content, _now_kst().isoformat()),
            )
        else:
            conn.execute(
                "DELETE FROM attendance_schedule_memos WHERE member_id = ? AND date = ?",
                (body.memberId, body.date),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "memos": [_memo_row_to_dict(r) for r in rows]}

    @router.delete("/schedule/memos")
    def delete_schedule_memo(body: ScheduleMemoDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute(
            "DELETE FROM attendance_schedule_memos WHERE member_id = ? AND date = ?",
            (body.memberId, body.date),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "memos": [_memo_row_to_dict(r) for r in rows]}

    return router
```

- [ ] **Step 2: Verify no syntax errors**

Run: `python -m py_compile backend/api/attendance_routes.py`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual smoke check**

```bash
curl -s -X POST http://127.0.0.1:8000/attendance/schedule/memos \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"date\":\"2026-07-06\",\"content\":\"30분 일찍 퇴근\"}"
```

Expected: `{"ok":true,"memos":[{"id":1,"memberId":1,"date":"2026-07-06","content":"30분 일찍 퇴근"}]}`

```bash
curl -s -X POST http://127.0.0.1:8000/attendance/schedule/memos \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"1234\",\"memberId\":1,\"date\":\"2026-07-06\",\"content\":\"\"}"
```

Expected: `{"ok":true,"memos":[]}` (empty content deletes it)

- [ ] **Step 4: Commit**

```bash
git add backend/api/attendance_routes.py
git commit -m "feat: add schedule memo upsert/delete endpoints"
```

---

### Task 6: Frontend — `ScheduleTab.module.css`

**Files:**
- Create: `src/components/Attendance/ScheduleTab.module.css`

**Interfaces:**
- Produces: CSS module class names consumed by Task 7's JSX (`styles.root`, `styles.toolbar`, `styles.table`, `styles.modal`, etc. — full list below).

**Note:** Ported from the reference app's `styles.css`, with two safety fixes required because this CSS module will be mounted inside `AttendanceAdminPage.jsx` alongside other tabs that share the same DOM: (1) the bare-element selectors `button {}` and `input, select, textarea {}` are rescoped under a `.root` ancestor class so they don't leak and restyle every button/input on the other tabs — CSS Modules only hashes **class** selectors, not bare element selectors, so an unscoped `button {}` rule would apply page-wide. (2) the `body {}` rule and top-level `.app` class are dropped/renamed (`.app` → `.root`) since this is a tab inside a page, not a standalone page.

- [ ] **Step 1: Create the CSS module**

```css
.root {
  font-family: "Segoe UI", "Pretendard", "Noto Sans KR", Arial, sans-serif;
  color: #172033;
}

.root input,
.root select,
.root textarea {
  border: 1px solid #cfd9e6;
  border-radius: 4px;
  padding: 8px 10px;
  box-sizing: border-box;
  background: white;
  color: #172033;
  font: inherit;
}

.root button {
  cursor: pointer;
  border: 1px solid #cfd9e6;
  background: #ffffff;
  border-radius: 4px;
  padding: 8px 12px;
  color: #172033;
  font-weight: 700;
  transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.root button:hover {
  background: #f4f7fb;
  border-color: #9fb2ca;
  transform: translateY(-1px);
}

.modeButton.active {
  background: #203f73;
  border-color: #203f73;
  color: white;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  padding: 18px 20px;
  background: #ffffff;
  border: 1px solid #d9e2ec;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgb(15 23 42 / 7%);
}

.titleArea {
  display: grid;
  gap: 6px;
  text-align: center;
}

.titleArea h1 {
  margin: 0;
  color: #15213a;
  font-size: 26px;
  font-weight: 800;
}

.datePicker {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 14px;
}

.copyStatus {
  margin: 0;
  color: #2f5597;
  font-size: 13px;
  font-weight: 700;
}

.errorBanner {
  margin: 0 0 18px;
  padding: 10px 14px;
  border: 1px solid #f0a7b5;
  border-radius: 6px;
  background: #fff1f2;
  color: #be123c;
  font-size: 13px;
  font-weight: 700;
}

.employeePanel {
  display: grid;
  gap: 14px;
  margin-bottom: 18px;
  padding: 18px;
  background: white;
  border: 1px solid #d9e2ec;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgb(15 23 42 / 6%);
}

.employeePanel h2,
.employeePanel p {
  margin: 0;
}

.employeePanel p {
  margin-top: 4px;
  color: #64748b;
  font-size: 14px;
}

.employeeForm {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.fixedDatePanel {
  margin-top: -8px;
}

.fixedEmployeeList {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}

.fixedEmployee {
  min-height: 42px;
  text-align: center;
}

.fixedEmployee.active {
  background: #203f73;
  border-color: #203f73;
  color: white;
}

.fixedDateActions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.weekdayToggleGroup {
  display: grid;
  grid-template-columns: repeat(5, minmax(64px, 1fr));
  gap: 8px;
}

.weekdayToggle {
  min-height: 54px;
  background: #f8fafc;
  color: #64748b;
}

.weekdayToggle.active {
  background: #1d6fd8;
  border-color: #1d6fd8;
  color: white;
  box-shadow: 0 8px 18px rgb(29 111 216 / 22%);
}

.weekdayToggle:disabled {
  cursor: default;
  opacity: 1;
  transform: none;
}

.weekdayToggle span {
  display: block;
  font-size: 18px;
  font-weight: 800;
}

.weekdayToggle em {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-style: normal;
}

.fixedDateSaveRow {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.fixedTimeEditor {
  display: grid;
  grid-template-columns: repeat(2, minmax(140px, 1fr));
  gap: 12px;
  padding: 14px;
  border: 1px solid #d8e1ed;
  border-radius: 6px;
  background: #f8fafc;
}

.fixedTimeEditor label {
  display: grid;
  gap: 6px;
  font-weight: 700;
}

.fixedTimeEditor .modalSummary,
.fixedTimeEditor .fixedDateSaveRow {
  grid-column: 1 / -1;
}

.calendarPanel {
  margin-top: -8px;
}

.calendarControls {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
}

.calendarControlGroup {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}

.calendarControls label {
  display: grid;
  gap: 6px;
  font-weight: 700;
}

.calendarTimeToggle {
  min-height: 38px;
  display: flex !important;
  align-items: center;
  gap: 8px !important;
  padding: 8px 10px;
  border: 1px solid #cfd9e6;
  border-radius: 4px;
  background: #f8fafc;
  box-sizing: border-box;
  font-size: 14px;
}

.calendarTimeToggle input {
  width: 16px;
  height: 16px;
  padding: 0;
}

.calendarSelectionSummary {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  color: #2f5597;
  font-size: 14px;
  font-weight: 800;
  text-align: right;
}

.calendarMonthTitle {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 58px;
  color: #15213a;
  font-size: 38px;
  font-weight: 900;
}

.monthlyCalendar {
  display: grid;
  grid-template-columns: repeat(5, minmax(112px, 1fr));
  overflow: hidden;
  border: 1px solid #c8d4e2;
  border-radius: 8px;
  background: #d6dee8;
}

.calendarWeekday {
  min-height: 36px;
  display: grid;
  place-items: center;
  background: #203f73;
  color: white;
  font-size: 14px;
  font-weight: 800;
}

.calendarDay {
  min-height: 104px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 8px;
  padding: 8px;
  background: #ffffff;
  box-sizing: border-box;
}

.calendarDay.holiday {
  background: #fff8f0;
}

.calendarDay.outsideMonth {
  background: #f3f7fb;
  color: #94a3b8;
}

.calendarDay.empty {
  background: #f3f7fb;
}

.calendarDateHeader {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.calendarDateNumber {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #eef6ff;
  color: #203f73;
  font-size: 13px;
  font-weight: 900;
}

.holidayBadge {
  min-width: 0;
  color: #b45309;
  font-size: 11px;
  font-weight: 900;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.outsideMonth .calendarDateNumber {
  background: #e7edf5;
  color: #94a3b8;
}

.calendarNameList {
  display: flex;
  align-content: flex-start;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 5px;
}

.calendarNameBadge {
  max-width: 100%;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 4px;
  padding: 4px 7px;
  border: 1px solid #9cc7ff;
  border-radius: 4px;
  background: #e8f3ff;
  color: #144a86;
  font-size: 13px;
  font-weight: 900;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.calendarNameBadge small {
  width: 100%;
  color: #2f5597;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.15;
}

.calendarNameBadge.dayOff {
  border-color: #f0a7b5;
  background: #fff1f2;
  color: #be123c;
}

.calendarNameList.dense .calendarNameBadge {
  padding: 3px 5px;
  font-size: 11px;
}

.table {
  background: white;
  border: 1px solid #c8d4e2;
  border-radius: 8px;
  overflow-x: auto;
  box-shadow: 0 14px 36px rgb(15 23 42 / 8%);
}

.row {
  display: grid;
  grid-template-columns: 124px repeat(5, minmax(132px, 1fr)) 112px;
}

.header {
  background: #203f73;
  color: white;
  font-weight: bold;
}

.footer {
  font-weight: bold;
}

.hoursFooter .cell {
  background: #dcecff;
}

.peopleFooter .cell {
  background: #fff0df;
}

.cell {
  min-height: 56px;
  border-right: 1px solid #d6dee8;
  border-bottom: 1px solid #d6dee8;
  padding: 8px;
  box-sizing: border-box;
}

.name {
  background: #f9fbfd;
  font-weight: bold;
}

.header .name,
.header .cell {
  background: #203f73;
}

.total {
  background: #f3f7fb;
  text-align: right;
  font-weight: bold;
}

.dayHeader {
  display: grid;
  align-content: center;
  gap: 3px;
  cursor: context-menu;
}

.dayHeader span {
  color: #d9e8ff;
  font-size: 13px;
}

.dayHeader.holiday {
  background: #7c2d12;
}

.dayHeader.holiday em {
  color: #ffedd5;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.shift {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 56px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  transition: background 120ms ease, box-shadow 120ms ease;
}

.shift:hover {
  background: #f4f7fb;
}

.shift:focus-visible {
  outline: 3px solid #16a34a;
  outline-offset: -3px;
}

.shift.filled {
  background: #fbfdff;
}

.shift.filled:hover {
  background: #eef6ff;
}

.shift.dayOff {
  background: #fff1f2;
  color: #be123c;
}

.shift.dayOff:hover {
  background: #ffe4e6;
}

.shift.dayOff strong {
  color: #be123c;
}

.shift.override {
  box-shadow: inset 0 0 0 2px #7aa7df;
}

.shift.selected {
  position: relative;
  z-index: 1;
  box-shadow: inset 0 0 0 3px #16a34a;
}

.shift strong,
.shift em {
  display: block;
}

.shift strong {
  color: #12213a;
  font-size: 16px;
  font-weight: 800;
}

.shift em {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

.dayContextMenu {
  position: fixed;
  z-index: 30;
  width: 152px;
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid #cfd9e6;
  border-radius: 6px;
  background: #ffffff;
  box-shadow: 0 18px 45px rgb(15 23 42 / 18%);
  box-sizing: border-box;
}

.dayContextMenu strong {
  color: #172033;
  font-size: 13px;
  line-height: 1.2;
}

.dayContextMenu button {
  width: 100%;
  background: #fff1f2;
  border-color: #f0a7b5;
  color: #be123c;
}

.dayContextMenu button:hover {
  background: #ffe4e6;
  border-color: #fb7185;
}

.memoBadge {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-color: #f4c430;
  background: #fff8db;
  font-size: 15px;
  line-height: 1;
}

.memoBadge:hover {
  background: #ffef9f;
  border-color: #d7a900;
}

.modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: rgb(0 0 0 / 40%);
  display: grid;
  place-items: center;
}

.modal {
  width: 360px;
  background: white;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 24px 80px rgb(15 23 42 / 25%);
}

.modal label {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}

.modal select,
.modal input,
.modal textarea {
  width: 100%;
}

.modal textarea {
  min-height: 120px;
  resize: vertical;
  line-height: 1.5;
}

.modalTabs {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-top: 14px;
}

.modalTabs button.active {
  background: #203f73;
  border-color: #203f73;
  color: white;
}

.modalSummary {
  margin: 12px 0 0;
  font-weight: bold;
}

.shortcutHint {
  margin-top: 12px;
  padding: 10px;
  border-radius: 4px;
  background: #f4f7fb;
  color: #475569;
  font-size: 13px;
  line-height: 1.5;
}

.actions {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

@media (max-width: 760px) {
  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .row {
    grid-template-columns: 104px repeat(5, 112px) 96px;
  }

  .calendarControls {
    align-items: stretch;
    flex-direction: column;
  }

  .calendarControlGroup {
    align-items: stretch;
    flex-direction: column;
  }

  .calendarSelectionSummary {
    justify-content: flex-start;
    text-align: left;
  }

  .monthlyCalendar {
    grid-template-columns: repeat(5, minmax(86px, 1fr));
    overflow-x: auto;
  }

  .calendarMonthTitle {
    min-height: 48px;
    font-size: 30px;
  }

  .calendarDay {
    min-height: 92px;
    padding: 6px;
  }

  .titleArea h1 {
    font-size: 22px;
  }
}
```

- [ ] **Step 2: Verify the file was created**

Run: `test -f "src/components/Attendance/ScheduleTab.module.css" && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/components/Attendance/ScheduleTab.module.css
git commit -m "feat: add ScheduleTab CSS module ported from reference app"
```

---

### Task 7: Frontend — `ScheduleTab.jsx`

**Files:**
- Create: `src/components/Attendance/ScheduleTab.jsx`

**Interfaces:**
- Consumes: `styles` from `./ScheduleTab.module.css` (Task 6); backend endpoints from Tasks 2-5 (`GET/POST /attendance/schedule*`); `LOCAL_API_BASE`/`COLLAB_API_BASE` — **uses `COLLAB_API_BASE`** since `/attendance/*` is registered on the collab server (matching how `AttendanceAdminPage.jsx` already calls it).
- Produces: `export default function ScheduleTab({ pin, members })` — consumed by Task 8.

- [ ] **Step 1: Create the component**

```jsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, format, startOfWeek } from "date-fns";
import styles from "./ScheduleTab.module.css";
import { COLLAB_API_BASE } from "../../lib/api";

const API = COLLAB_API_BASE;

const DAY_NAMES = ["월", "화", "수", "목", "금"];
const WEEKDAYS = [1, 2, 3, 4, 5];

const KOREAN_HOLIDAYS = [
  { date: "2026-01-01", name: "신정" },
  { date: "2026-02-16", name: "설날 연휴" },
  { date: "2026-02-17", name: "설날" },
  { date: "2026-02-18", name: "설날 연휴" },
  { date: "2026-03-02", name: "삼일절 대체공휴일" },
  { date: "2026-05-05", name: "어린이날" },
  { date: "2026-05-25", name: "부처님오신날 대체공휴일" },
  { date: "2026-06-03", name: "지방선거일" },
  { date: "2026-08-17", name: "광복절 대체공휴일" },
  { date: "2026-09-24", name: "추석 연휴" },
  { date: "2026-09-25", name: "추석" },
  { date: "2026-10-05", name: "개천절 대체공휴일" },
  { date: "2026-10-09", name: "한글날" },
  { date: "2026-12-25", name: "성탄절" },
  { date: "2027-01-01", name: "신정" },
  { date: "2027-02-05", name: "설날 연휴" },
  { date: "2027-02-08", name: "설날 대체공휴일" },
  { date: "2027-03-01", name: "삼일절" },
  { date: "2027-05-05", name: "어린이날" },
  { date: "2027-05-13", name: "부처님오신날" },
  { date: "2027-08-16", name: "광복절 대체공휴일" },
  { date: "2027-09-14", name: "추석 연휴" },
  { date: "2027-09-15", name: "추석" },
  { date: "2027-09-16", name: "추석 연휴" },
  { date: "2027-10-04", name: "개천절 대체공휴일" },
  { date: "2027-10-11", name: "한글날 대체공휴일" },
  { date: "2027-12-27", name: "성탄절 대체공휴일" },
  { date: "2028-01-25", name: "설날 연휴" },
  { date: "2028-01-26", name: "설날" },
  { date: "2028-01-27", name: "설날 연휴" },
  { date: "2028-03-01", name: "삼일절" },
  { date: "2028-05-02", name: "부처님오신날" },
  { date: "2028-05-05", name: "어린이날" },
  { date: "2028-06-06", name: "현충일" },
  { date: "2028-08-15", name: "광복절" },
  { date: "2028-10-02", name: "추석 연휴" },
  { date: "2028-10-03", name: "추석/개천절" },
  { date: "2028-10-04", name: "추석 연휴" },
  { date: "2028-10-05", name: "추석 대체공휴일" },
  { date: "2028-10-09", name: "한글날" },
  { date: "2028-12-25", name: "성탄절" },
  { date: "2029-01-01", name: "신정" },
  { date: "2029-02-12", name: "설날 연휴" },
  { date: "2029-02-13", name: "설날" },
  { date: "2029-02-14", name: "설날 연휴" },
  { date: "2029-03-01", name: "삼일절" },
  { date: "2029-05-07", name: "어린이날 대체공휴일" },
  { date: "2029-05-21", name: "부처님오신날 대체공휴일" },
  { date: "2029-06-06", name: "현충일" },
  { date: "2029-08-15", name: "광복절" },
  { date: "2029-09-21", name: "추석 연휴" },
  { date: "2029-09-24", name: "추석 대체공휴일" },
  { date: "2029-10-03", name: "개천절" },
  { date: "2029-10-09", name: "한글날" },
  { date: "2029-12-25", name: "성탄절" },
  { date: "2030-01-01", name: "신정" },
  { date: "2030-02-04", name: "설날" },
  { date: "2030-02-05", name: "설날 연휴" },
  { date: "2030-02-06", name: "설날 대체공휴일" },
  { date: "2030-03-01", name: "삼일절" },
  { date: "2030-05-06", name: "어린이날 대체공휴일" },
  { date: "2030-05-09", name: "부처님오신날" },
  { date: "2030-06-06", name: "현충일" },
  { date: "2030-08-15", name: "광복절" },
  { date: "2030-09-11", name: "추석 연휴" },
  { date: "2030-09-12", name: "추석" },
  { date: "2030-09-13", name: "추석 연휴" },
  { date: "2030-10-03", name: "개천절" },
  { date: "2030-10-09", name: "한글날" },
  { date: "2030-12-25", name: "성탄절" },
];

const TIME_OPTIONS = Array.from({ length: 29 }, (_, index) => {
  const totalMinutes = 8 * 60 + index * 30;
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
});

function getHours(start, end) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour + endMinute / 60 - (startHour + startMinute / 60);
}

function formatHours(value) {
  return `${value.toFixed(1)}h`;
}

function getHoliday(date) {
  return KOREAN_HOLIDAYS.find((holiday) => holiday.date === date) ?? null;
}

export default function ScheduleTab({ pin, members }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [fixedRules, setFixedRules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [memos, setMemos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState("");

  const [selected, setSelected] = useState(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("14:00");
  const [copiedShift, setCopiedShift] = useState(null);
  const [showTimes, setShowTimes] = useState(false);
  const [showFixedDateManager, setShowFixedDateManager] = useState(false);
  const [showFixedTimeManager, setShowFixedTimeManager] = useState(false);
  const [showCalendarView, setShowCalendarView] = useState(false);
  const [selectedFixedMemberId, setSelectedFixedMemberId] = useState(null);
  const [editingFixedDays, setEditingFixedDays] = useState(null);
  const [selectedFixedTimeMemberId, setSelectedFixedTimeMemberId] = useState(null);
  const [selectedFixedTimeWeekday, setSelectedFixedTimeWeekday] = useState(null);
  const [fixedTimeStart, setFixedTimeStart] = useState("09:00");
  const [fixedTimeEnd, setFixedTimeEnd] = useState("14:00");
  const [selectedCalendarMemberIds, setSelectedCalendarMemberIds] = useState([]);
  const [calendarMonth, setCalendarMonth] = useState(() => format(new Date(), "yyyy-MM"));
  const [showCalendarTimes, setShowCalendarTimes] = useState(false);
  const [editorTab, setEditorTab] = useState("shift");
  const [memoDraft, setMemoDraft] = useState("");
  const [dayContextMenu, setDayContextMenu] = useState(null);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setScheduleError("");
    try {
      const params = new URLSearchParams({ pin });
      const res = await fetch(`${API}/attendance/schedule?${params}`);
      if (!res.ok) throw new Error("스케줄 데이터를 불러오지 못했습니다.");
      const data = await res.json();
      setFixedRules(data.fixedRules || []);
      setOverrides(data.overrides || []);
      setMemos(data.memos || []);
    } catch (err) {
      setScheduleError(err.message || "스케줄 데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  useEffect(() => {
    if (!dayContextMenu) return;
    const closeMenu = () => setDayContextMenu(null);
    const closeOnEscape = (event) => { if (event.key === "Escape") closeMenu(); };
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [dayContextMenu]);

  const weekDays = useMemo(
    () => WEEKDAYS.map((weekday, index) => {
      const date = addDays(weekStart, index);
      return {
        weekday,
        date: format(date, "yyyy-MM-dd"),
        dayName: DAY_NAMES[index],
        label: format(date, "MM/dd"),
      };
    }),
    [weekStart]
  );

  const getFixedRule = (memberId, weekday, date) => {
    const candidates = fixedRules.filter(
      (r) => r.memberId === memberId && r.weekday === weekday && r.effectiveFrom <= date
    );
    if (!candidates.length) return null;
    const best = candidates.reduce((acc, cur) => {
      if (!acc) return cur;
      if (cur.effectiveFrom !== acc.effectiveFrom) {
        return cur.effectiveFrom > acc.effectiveFrom ? cur : acc;
      }
      return cur.id > acc.id ? cur : acc;
    }, null);
    return best && best.status === "scheduled" ? best : null;
  };

  const getOverride = (memberId, date) =>
    overrides.find((o) => o.memberId === memberId && o.date === date);

  const getMemo = (memberId, date) =>
    memos.find((m) => m.memberId === memberId && m.date === date);

  const getVisibleShift = (memberId, weekday, date) => {
    const override = getOverride(memberId, date);
    if (override) {
      if (override.status === "none") return null;
      return {
        memberId, weekday, date,
        startTime: override.startTime, endTime: override.endTime,
        status: override.status, source: "override",
      };
    }
    const fixedRule = getFixedRule(memberId, weekday, date);
    if (!fixedRule) return null;
    if (getHoliday(date)) {
      return {
        memberId, weekday, date,
        startTime: fixedRule.startTime, endTime: fixedRule.endTime,
        status: "dayOff", source: "holiday",
      };
    }
    return {
      memberId, weekday, date,
      startTime: fixedRule.startTime, endTime: fixedRule.endTime,
      status: "scheduled", source: "fixed",
    };
  };

  const selectedShift = selected ? getVisibleShift(selected.memberId, selected.weekday, selected.date) : null;
  const selectedMember = members.find((m) => m.id === selected?.memberId);

  const visibleShifts = members.flatMap((member) =>
    weekDays
      .map((day) => getVisibleShift(member.id, day.weekday, day.date))
      .filter((shift) => Boolean(shift))
  );
  const activeShifts = visibleShifts.filter((shift) => shift.status !== "dayOff");

  const weeklyHours = (memberId) =>
    activeShifts
      .filter((shift) => shift.memberId === memberId)
      .reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  const dailyHours = (date) =>
    activeShifts
      .filter((shift) => shift.date === date)
      .reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  const dailyWorkerCount = (date) =>
    activeShifts.filter((shift) => shift.date === date).length;

  const totalWeeklyHours = activeShifts.reduce((total, shift) => total + getHours(shift.startTime, shift.endTime), 0);

  return (
    <div className={styles.root}>
      {scheduleError && <div className={styles.errorBanner}>{scheduleError}</div>}
      {loading && <div className={styles.errorBanner} style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}>불러오는 중...</div>}

      <header className={styles.toolbar}>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>이전 주</button>
        <div className={styles.titleArea}>
          <h1>근무표</h1>
          <label className={styles.datePicker}>
            주차 이동
            <input
              type="date"
              value={format(weekStart, "yyyy-MM-dd")}
              onChange={(event) => setWeekStart(startOfWeek(new Date(event.target.value), { weekStartsOn: 1 }))}
            />
          </label>
          <p className={styles.copyStatus}>
            {format(weekStart, "yyyy.MM.dd")} 주차 · Ctrl+C / Ctrl+V / Delete
          </p>
          {copiedShift && (
            <p className={styles.copyStatus}>복사됨: {copiedShift.startTime}-{copiedShift.endTime}</p>
          )}
        </div>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>다음 주</button>
      </header>

      <section className={styles.employeePanel}>
        <div>
          <h2>근무표 관리</h2>
          <p>휴무와 날짜별 수정은 표에서, 고정 요일 변경은 직원별로 관리합니다.</p>
        </div>
        <div className={styles.employeeForm}>
          <button onClick={() => setShowTimes((prev) => !prev)}>
            {showTimes ? "시간대 숨기기 ▲" : "시간대 보기 ▼"}
          </button>
          <button
            className={showFixedDateManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedDateManager((prev) => !prev); setEditingFixedDays(null); }}
          >
            {showFixedDateManager ? "고정날짜 닫기" : "고정날짜 변경"}
          </button>
          <button
            className={showFixedTimeManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedTimeManager((prev) => !prev); setSelectedFixedTimeWeekday(null); }}
          >
            {showFixedTimeManager ? "고정시간 닫기" : "고정시간 변경"}
          </button>
          <button
            className={showCalendarView ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => setShowCalendarView((prev) => !prev)}
          >
            {showCalendarView ? "캘린더 닫기" : "캘린더 보기"}
          </button>
        </div>
      </section>

      <section className={styles.table}>
        <div className={`${styles.row} ${styles.header}`}>
          <div className={`${styles.cell} ${styles.name}`}>직원</div>
          {weekDays.map((day) => {
            const holiday = getHoliday(day.date);
            return (
              <div
                className={`${styles.cell} ${styles.dayHeader} ${holiday ? styles.holiday : ""}`}
                key={day.weekday}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setDayContextMenu({
                    weekday: day.weekday, date: day.date, dayName: day.dayName, label: day.label,
                    x: event.clientX, y: event.clientY,
                  });
                }}
              >
                <strong>{day.dayName}</strong>
                <span>{day.label}</span>
                {holiday && <em>{holiday.name}</em>}
              </div>
            );
          })}
          <div className={`${styles.cell} ${styles.total}`}>주간합계</div>
        </div>

        {members.map((member) => (
          <div className={styles.row} key={member.id}>
            <div className={`${styles.cell} ${styles.name}`}>{member.name}</div>
            {weekDays.map((day) => {
              const shift = getVisibleShift(member.id, day.weekday, day.date);
              const holiday = getHoliday(day.date);
              const memo = getMemo(member.id, day.date);
              const isDayOff = shift?.status === "dayOff";
              const shiftHours = shift && !isDayOff ? getHours(shift.startTime, shift.endTime) : 0;
              const isSelected = selected?.memberId === member.id && selected?.weekday === day.weekday && selected?.date === day.date;

              return (
                <div
                  className={`${styles.cell} ${styles.shift} ${shift ? styles.filled : ""} ${isDayOff ? styles.dayOff : ""} ${shift?.source === "override" ? styles.override : ""} ${isSelected ? styles.selected : ""}`}
                  key={day.weekday}
                  role="button"
                  tabIndex={0}
                  onClick={() => openCell(member.id, day.weekday, day.date, shift, false)}
                  onDoubleClick={() => openCell(member.id, day.weekday, day.date, shift, true)}
                  onKeyDown={(event) => { if (event.key === "Enter") openCell(member.id, day.weekday, day.date, shift, true); }}
                >
                  {memo && (
                    <button
                      className={styles.memoBadge}
                      title={memo.content}
                      onClick={(event) => { event.stopPropagation(); openCell(member.id, day.weekday, day.date, shift, true, "memo"); }}
                    >
                      📝
                    </button>
                  )}
                  {!shift && <span>+</span>}
                  {shift && isDayOff && (
                    <>
                      <strong>{shift.source === "holiday" ? "공휴일" : "휴무"}</strong>
                      {shift.source === "holiday" && holiday && <em>{holiday.name}</em>}
                      {showTimes && <em>기존 {shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                  {shift && !isDayOff && (
                    <>
                      <strong>{formatHours(shiftHours)}</strong>
                      {showTimes && <em>{shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                </div>
              );
            })}
            <div className={`${styles.cell} ${styles.total}`}>{formatHours(weeklyHours(member.id))}</div>
          </div>
        ))}

        <div className={`${styles.row} ${styles.footer} ${styles.hoursFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>일 총 근무시간</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{formatHours(dailyHours(day.date))}</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>{formatHours(totalWeeklyHours)}</div>
        </div>

        <div className={`${styles.row} ${styles.footer} ${styles.peopleFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>출근 인원</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{dailyWorkerCount(day.date)}명</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>-</div>
        </div>
      </section>
    </div>
  );

  function openCell(memberId, weekday, date, shift, shouldOpenEditor, tab = "shift") {
    setSelected({ memberId, weekday, date });
    setIsEditorOpen(shouldOpenEditor);
    setEditorTab(tab);
    setStartTime(shift?.startTime ?? copiedShift?.startTime ?? "09:00");
    setEndTime(shift?.endTime ?? copiedShift?.endTime ?? "14:00");
    setMemoDraft(getMemo(memberId, date)?.content ?? "");
  }
}
```

- [ ] **Step 2: Verify no build/lint errors**

Run: `npm run lint`
Expected: no errors reported for `src/components/Attendance/ScheduleTab.jsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/Attendance/ScheduleTab.jsx
git commit -m "feat: add ScheduleTab weekly grid (view-only skeleton)"
```

---

### Task 8: Frontend — cell editor (shift + memo tabs), copy/paste/delete, day context menu, fixed managers, calendar view

**Files:**
- Modify: `src/components/Attendance/ScheduleTab.jsx` (this task adds everything the Task 7 skeleton doesn't yet have — the rest of the reference app's functionality)

**Interfaces:**
- Consumes: everything from Task 7 (state, `weekDays`, `getVisibleShift`, `getFixedRule`, `getOverride`, `getMemo`, `weeklyHours`, `activeShifts`).
- Produces: a fully working `ScheduleTab` — the complete deliverable this plan builds toward. Consumed by Task 9 (mounted into `AttendanceAdminPage.jsx`).

- [ ] **Step 1: Replace the `return (...)` block and the trailing `openCell` function with the full version**

This is a large replacement. Find the entire block starting at `return (` (right after `const totalWeeklyHours = ...` line) through the end of the file (the closing `}` of `ScheduleTab`), and replace it with:

```jsx
  const selectedFixedMember = members.find((m) => m.id === selectedFixedMemberId);
  const selectedFixedTimeMember = members.find((m) => m.id === selectedFixedTimeMemberId);

  const fixedWeekdays = (memberId) =>
    weekDays.filter((day) => getFixedRule(memberId, day.weekday, day.date)).map((day) => day.weekday);

  const startFixedDateEdit = () => {
    if (!selectedFixedMemberId) return;
    setEditingFixedDays(fixedWeekdays(selectedFixedMemberId));
  };

  const toggleEditingFixedDay = (weekday) => {
    setEditingFixedDays((prev) => {
      const current = prev ?? [];
      return current.includes(weekday) ? current.filter((d) => d !== weekday) : [...current, weekday].sort();
    });
  };

  const getFallbackFixedTime = (memberId, effectiveFrom) => {
    const candidates = fixedRules.filter(
      (r) => r.memberId === memberId && r.status === "scheduled" && r.effectiveFrom <= effectiveFrom
    );
    const best = candidates.reduce((acc, cur) => {
      if (!acc) return cur;
      if (cur.effectiveFrom !== acc.effectiveFrom) return cur.effectiveFrom > acc.effectiveFrom ? cur : acc;
      return cur.id > acc.id ? cur : acc;
    }, null);
    return { startTime: best?.startTime ?? "09:00", endTime: best?.endTime ?? "14:00" };
  };

  const getFixedTimeForWeekday = (memberId, weekday, effectiveFrom) => {
    const day = weekDays.find((d) => d.weekday === weekday);
    const rule = day ? getFixedRule(memberId, weekday, day.date) : null;
    const fallback = getFallbackFixedTime(memberId, effectiveFrom);
    return { startTime: rule?.startTime ?? fallback.startTime, endTime: rule?.endTime ?? fallback.endTime };
  };

  const selectFixedTimeWeekday = (weekday) => {
    if (!selectedFixedTimeMemberId) return;
    const day = weekDays.find((d) => d.weekday === weekday);
    const rule = day ? getFixedRule(selectedFixedTimeMemberId, weekday, day.date) : null;
    if (!rule) { setScheduleError("고정날짜가 있는 요일만 고정시간을 변경할 수 있습니다."); return; }
    setScheduleError("");
    setSelectedFixedTimeWeekday(weekday);
    setFixedTimeStart(rule.startTime);
    setFixedTimeEnd(rule.endTime);
  };

  const saveBulkFixedRules = async (memberId, effectiveFrom, rules) => {
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/fixed-rules/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId, effectiveFrom, rules }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "고정 스케줄 저장에 실패했습니다.");
      setFixedRules(data.fixedRules || []);
      return true;
    } catch (err) {
      setScheduleError(err.message || "고정 스케줄 저장에 실패했습니다.");
      return false;
    }
  };

  const saveFixedTimeChange = async () => {
    if (!selectedFixedTimeMemberId || !selectedFixedTimeWeekday) return;
    const memberId = selectedFixedTimeMemberId;
    const effectiveFrom = format(weekStart, "yyyy-MM-dd");

    if (getHours(fixedTimeStart, fixedTimeEnd) <= 0) {
      setScheduleError("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }
    const totalHours = WEEKDAYS.reduce((total, weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      const start = weekday === selectedFixedTimeWeekday ? fixedTimeStart : t.startTime;
      const end = weekday === selectedFixedTimeWeekday ? fixedTimeEnd : t.endTime;
      return total + getHours(start, end);
    }, 0);
    if (totalHours > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return;
    }

    const rules = WEEKDAYS.map((weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      const isChanged = weekday === selectedFixedTimeWeekday;
      const day = weekDays.find((d) => d.weekday === weekday);
      const existingRule = day ? getFixedRule(memberId, weekday, day.date) : null;
      return {
        weekday,
        startTime: isChanged ? fixedTimeStart : t.startTime,
        endTime: isChanged ? fixedTimeEnd : t.endTime,
        status: existingRule ? "scheduled" : "none",
      };
    });
    const ok = await saveBulkFixedRules(memberId, effectiveFrom, rules);
    if (ok) setSelectedFixedTimeWeekday(null);
  };

  const saveFixedDateChange = async () => {
    if (!selectedFixedMemberId || !editingFixedDays) return;
    const memberId = selectedFixedMemberId;
    const effectiveFrom = format(weekStart, "yyyy-MM-dd");
    const totalHours = editingFixedDays.reduce((total, weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      return total + getHours(t.startTime, t.endTime);
    }, 0);
    if (totalHours > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return;
    }
    const rules = WEEKDAYS.map((weekday) => {
      const t = getFixedTimeForWeekday(memberId, weekday, effectiveFrom);
      return {
        weekday, startTime: t.startTime, endTime: t.endTime,
        status: editingFixedDays.includes(weekday) ? "scheduled" : "none",
      };
    });
    const ok = await saveBulkFixedRules(memberId, effectiveFrom, rules);
    if (ok) setEditingFixedDays(null);
  };

  const validateShift = (memberId, date, start, end) => {
    const shiftHours = getHours(start, end);
    if (shiftHours <= 0) {
      setScheduleError("종료 시간은 시작 시간보다 늦어야 합니다.");
      return false;
    }
    const current = activeShifts.find((shift) => shift.memberId === memberId && shift.date === date);
    const currentHours = current ? getHours(current.startTime, current.endTime) : 0;
    const total = weeklyHours(memberId) - currentHours + shiftHours;
    if (total > 15) {
      setScheduleError("직원별 주 15시간을 초과할 수 없습니다.");
      return false;
    }
    setScheduleError("");
    return true;
  };

  const upsertOverride = async (memberId, weekday, date, start, end, status) => {
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId, weekday, date, startTime: start, endTime: end, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "저장에 실패했습니다.");
      setOverrides(data.overrides || []);
      return true;
    } catch (err) {
      setScheduleError(err.message || "저장에 실패했습니다.");
      return false;
    }
  };

  const openDayContextMenu = (event, day) => {
    event.preventDefault();
    setDayContextMenu({
      weekday: day.weekday, date: day.date, dayName: day.dayName, label: day.label,
      x: event.clientX, y: event.clientY,
    });
  };

  const markDateOff = async () => {
    if (!dayContextMenu) return;
    const { weekday, date } = dayContextMenu;
    setScheduleError("");
    let lastOverrides = overrides;
    try {
      for (const member of members) {
        const shift = getVisibleShift(member.id, weekday, date);
        const res = await fetch(`${API}/attendance/schedule/overrides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pin, memberId: member.id, weekday, date,
            startTime: shift?.startTime ?? "09:00",
            endTime: shift?.endTime ?? "14:00",
            status: "dayOff",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "휴무 지정에 실패했습니다.");
        lastOverrides = data.overrides || lastOverrides;
      }
      setOverrides(lastOverrides);
    } catch (err) {
      setScheduleError(err.message || "휴무 지정에 실패했습니다.");
    }
    setSelected(null);
    setIsEditorOpen(false);
    setDayContextMenu(null);
  };

  const saveShift = async () => {
    if (!selected) return;
    if (!validateShift(selected.memberId, selected.date, startTime, endTime)) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, startTime, endTime, "scheduled");
    if (ok) setSelected(null);
  };

  const copySelectedShift = () => {
    if (!selectedShift || selectedShift.status === "dayOff") return;
    setCopiedShift({ startTime: selectedShift.startTime, endTime: selectedShift.endTime });
  };

  const pasteCopiedShift = async () => {
    if (!selected || !copiedShift) return;
    if (!validateShift(selected.memberId, selected.date, copiedShift.startTime, copiedShift.endTime)) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, copiedShift.startTime, copiedShift.endTime, "scheduled");
    if (ok) setSelected(null);
  };

  const deleteShift = async () => {
    if (!selected) return;
    const ok = await upsertOverride(
      selected.memberId, selected.weekday, selected.date,
      selectedShift?.startTime ?? startTime, selectedShift?.endTime ?? endTime, "none"
    );
    if (ok) setSelected(null);
  };

  const markDayOff = async () => {
    if (!selected || !selectedShift) return;
    const ok = await upsertOverride(selected.memberId, selected.weekday, selected.date, selectedShift.startTime, selectedShift.endTime, "dayOff");
    if (ok) setSelected(null);
  };

  const restoreDate = async () => {
    if (!selected) return;
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/overrides`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "예외 해제에 실패했습니다.");
      setOverrides(data.overrides || []);
      setSelected(null);
    } catch (err) {
      setScheduleError(err.message || "예외 해제에 실패했습니다.");
    }
  };

  const openCell = (memberId, weekday, date, shift, shouldOpenEditor, tab = "shift") => {
    setSelected({ memberId, weekday, date });
    setIsEditorOpen(shouldOpenEditor);
    setEditorTab(tab);
    setStartTime(shift?.startTime ?? copiedShift?.startTime ?? "09:00");
    setEndTime(shift?.endTime ?? copiedShift?.endTime ?? "14:00");
    setMemoDraft(getMemo(memberId, date)?.content ?? "");
  };

  const saveMemo = async () => {
    if (!selected) return;
    const content = memoDraft.trim();
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/memos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "메모 저장에 실패했습니다.");
      setMemos(data.memos || []);
      setIsEditorOpen(false);
    } catch (err) {
      setScheduleError(err.message || "메모 저장에 실패했습니다.");
    }
  };

  const deleteMemo = async () => {
    if (!selected) return;
    setScheduleError("");
    try {
      const res = await fetch(`${API}/attendance/schedule/memos`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, memberId: selected.memberId, date: selected.date }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "메모 삭제에 실패했습니다.");
      setMemos(data.memos || []);
      setMemoDraft("");
      setIsEditorOpen(false);
    } catch (err) {
      setScheduleError(err.message || "메모 삭제에 실패했습니다.");
    }
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selected) return;
      const tagName = event.target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "select" || tagName === "textarea") return;
      if (event.ctrlKey && event.key.toLowerCase() === "c") { event.preventDefault(); copySelectedShift(); }
      if (event.ctrlKey && event.key.toLowerCase() === "v") { event.preventDefault(); pasteCopiedShift(); }
      if (event.key === "Delete") { event.preventDefault(); deleteShift(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const toggleCalendarMember = (memberId) => {
    setSelectedCalendarMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const calendarDays = useMemo(() => {
    const [year, month] = calendarMonth.split("-").map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const firstCalendarIndex = (monthStart.getDay() + 6) % 7;
    const calendarStart = addDays(monthStart, -firstCalendarIndex);
    return Array.from({ length: 30 }, (_, index) => {
      const weekIndex = Math.floor(index / 5);
      const weekdayIndex = index % 5;
      const date = addDays(calendarStart, weekIndex * 7 + weekdayIndex);
      return {
        date: format(date, "yyyy-MM-dd"),
        day: format(date, "d"),
        weekday: weekdayIndex + 1,
        isCurrentMonth: date.getMonth() === monthStart.getMonth(),
        isNextMonth: date > monthStart && date.getMonth() !== monthStart.getMonth(),
      };
    });
  }, [calendarMonth]);

  const calendarMonthTitle = useMemo(() => {
    const [, month] = calendarMonth.split("-");
    return `${Number(month)}월`;
  }, [calendarMonth]);

  const calendarMemberNames = selectedCalendarMemberIds
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean);

  return (
    <div className={styles.root}>
      {scheduleError && <div className={styles.errorBanner}>{scheduleError}</div>}
      {loading && <div className={styles.errorBanner} style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}>불러오는 중...</div>}

      <header className={styles.toolbar}>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))}>이전 주</button>
        <div className={styles.titleArea}>
          <h1>근무표</h1>
          <label className={styles.datePicker}>
            주차 이동
            <input
              type="date"
              value={format(weekStart, "yyyy-MM-dd")}
              onChange={(event) => setWeekStart(startOfWeek(new Date(event.target.value), { weekStartsOn: 1 }))}
            />
          </label>
          <p className={styles.copyStatus}>
            {format(weekStart, "yyyy.MM.dd")} 주차 · Ctrl+C / Ctrl+V / Delete
          </p>
          {copiedShift && <p className={styles.copyStatus}>복사됨: {copiedShift.startTime}-{copiedShift.endTime}</p>}
        </div>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))}>다음 주</button>
      </header>

      <section className={styles.employeePanel}>
        <div>
          <h2>근무표 관리</h2>
          <p>휴무와 날짜별 수정은 표에서, 고정 요일 변경은 직원별로 관리합니다.</p>
        </div>
        <div className={styles.employeeForm}>
          <button onClick={() => setShowTimes((prev) => !prev)}>
            {showTimes ? "시간대 숨기기 ▲" : "시간대 보기 ▼"}
          </button>
          <button
            className={showFixedDateManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedDateManager((prev) => !prev); setEditingFixedDays(null); }}
          >
            {showFixedDateManager ? "고정날짜 닫기" : "고정날짜 변경"}
          </button>
          <button
            className={showFixedTimeManager ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => { setShowFixedTimeManager((prev) => !prev); setSelectedFixedTimeWeekday(null); }}
          >
            {showFixedTimeManager ? "고정시간 닫기" : "고정시간 변경"}
          </button>
          <button
            className={showCalendarView ? `${styles.modeButton} ${styles.active}` : styles.modeButton}
            onClick={() => setShowCalendarView((prev) => !prev)}
          >
            {showCalendarView ? "캘린더 닫기" : "캘린더 보기"}
          </button>
        </div>
      </section>

      {showFixedDateManager && (
        <section className={`${styles.employeePanel} ${styles.fixedDatePanel}`}>
          <div>
            <h2>고정날짜 변경</h2>
            <p>{format(weekStart, "yyyy.MM.dd")} 주차부터 이후 주차의 고정 요일이 변경됩니다.</p>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedFixedMemberId === member.id ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => { setSelectedFixedMemberId(member.id); setEditingFixedDays(null); }}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.fixedDateActions}>
            <strong>{selectedFixedMember ? `${selectedFixedMember.name} 고정날짜` : "직원을 선택해주세요"}</strong>
            <button onClick={startFixedDateEdit} disabled={!selectedFixedMemberId}>수정</button>
          </div>
          {selectedFixedMemberId && (
            <div className={styles.weekdayToggleGroup}>
              {weekDays.map((day) => {
                const activeDays = editingFixedDays ?? fixedWeekdays(selectedFixedMemberId);
                const isActive = activeDays.includes(day.weekday);
                return (
                  <button
                    className={isActive ? `${styles.weekdayToggle} ${styles.active}` : styles.weekdayToggle}
                    disabled={!editingFixedDays}
                    key={day.weekday}
                    onClick={() => toggleEditingFixedDay(day.weekday)}
                  >
                    <span>{day.dayName}</span>
                  </button>
                );
              })}
            </div>
          )}
          {editingFixedDays && (
            <div className={styles.fixedDateSaveRow}>
              <button onClick={saveFixedDateChange}>저장</button>
              <button onClick={() => setEditingFixedDays(null)}>취소</button>
            </div>
          )}
        </section>
      )}

      {showFixedTimeManager && (
        <section className={`${styles.employeePanel} ${styles.fixedDatePanel}`}>
          <div>
            <h2>고정시간 변경</h2>
            <p>{format(weekStart, "yyyy.MM.dd")} 주차부터 이후 주차의 고정 시간이 변경됩니다.</p>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedFixedTimeMemberId === member.id ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => { setSelectedFixedTimeMemberId(member.id); setSelectedFixedTimeWeekday(null); }}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.fixedDateActions}>
            <strong>{selectedFixedTimeMember ? `${selectedFixedTimeMember.name} 고정시간` : "직원을 선택해주세요"}</strong>
          </div>
          {selectedFixedTimeMemberId && (
            <div className={styles.weekdayToggleGroup}>
              {weekDays.map((day) => {
                const rule = getFixedRule(selectedFixedTimeMemberId, day.weekday, day.date);
                const isSelected = selectedFixedTimeWeekday === day.weekday;
                return (
                  <button
                    className={isSelected ? `${styles.weekdayToggle} ${styles.active}` : styles.weekdayToggle}
                    key={day.weekday}
                    onClick={() => selectFixedTimeWeekday(day.weekday)}
                  >
                    <span>{day.dayName}</span>
                    {rule ? <em>{rule.startTime}-{rule.endTime}</em> : <em>고정 없음</em>}
                  </button>
                );
              })}
            </div>
          )}
          {selectedFixedTimeMemberId && selectedFixedTimeWeekday && (
            <div className={styles.fixedTimeEditor}>
              <label>
                시작 시간
                <select value={fixedTimeStart} onChange={(e) => setFixedTimeStart(e.target.value)}>
                  {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <label>
                종료 시간
                <select value={fixedTimeEnd} onChange={(e) => setFixedTimeEnd(e.target.value)}>
                  {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <p className={styles.modalSummary}>표시: {formatHours(Math.max(0, getHours(fixedTimeStart, fixedTimeEnd)))}</p>
              <div className={styles.fixedDateSaveRow}>
                <button onClick={saveFixedTimeChange}>저장</button>
                <button onClick={() => setSelectedFixedTimeWeekday(null)}>취소</button>
              </div>
            </div>
          )}
        </section>
      )}

      {showCalendarView && (
        <section className={`${styles.employeePanel} ${styles.calendarPanel}`}>
          <div>
            <h2>캘린더 보기</h2>
            <p>직원과 년/월을 선택하면 해당 월의 근무일이 달력에 표시됩니다.</p>
          </div>
          <div className={styles.calendarControls}>
            <div className={styles.calendarControlGroup}>
              <label>
                년도 + 월
                <input type="month" value={calendarMonth} onChange={(e) => setCalendarMonth(e.target.value)} />
              </label>
              <label className={styles.calendarTimeToggle}>
                <input type="checkbox" checked={showCalendarTimes} onChange={(e) => setShowCalendarTimes(e.target.checked)} />
                출근시간대 표기
              </label>
            </div>
            <div className={styles.calendarSelectionSummary}>
              {calendarMemberNames.length > 0 ? calendarMemberNames.map((m) => m.name).join(", ") : "직원을 선택해주세요"}
            </div>
          </div>
          <div className={styles.fixedEmployeeList}>
            {members.map((member) => (
              <button
                className={selectedCalendarMemberIds.includes(member.id) ? `${styles.fixedEmployee} ${styles.active}` : styles.fixedEmployee}
                key={member.id}
                onClick={() => toggleCalendarMember(member.id)}
              >
                {member.name}
              </button>
            ))}
          </div>
          <div className={styles.calendarMonthTitle}>{calendarMonthTitle}</div>
          <div className={styles.monthlyCalendar}>
            {DAY_NAMES.map((dayName) => <div className={styles.calendarWeekday} key={dayName}>{dayName}</div>)}
            {calendarDays.map((day) => {
              if (day.isNextMonth) return <div className={`${styles.calendarDay} ${styles.empty}`} key={day.date} />;
              const holiday = getHoliday(day.date);
              const dayWorkers = calendarMemberNames
                .map((member) => ({ member, shift: getVisibleShift(member.id, day.weekday, day.date) }))
                .filter(({ shift }) => Boolean(shift));
              return (
                <div
                  className={`${styles.calendarDay} ${holiday ? styles.holiday : ""} ${day.isCurrentMonth ? "" : styles.outsideMonth}`}
                  key={day.date}
                >
                  <div className={styles.calendarDateHeader}>
                    <span className={styles.calendarDateNumber}>{day.day}</span>
                    {holiday && <span className={styles.holidayBadge}>{holiday.name}</span>}
                  </div>
                  <div className={`${styles.calendarNameList} ${dayWorkers.length >= 4 ? styles.dense : ""}`}>
                    {dayWorkers.map(({ member, shift }) => (
                      <span className={`${styles.calendarNameBadge} ${shift?.status === "dayOff" ? styles.dayOff : ""}`} key={member.id}>
                        <span>{member.name}</span>
                        {shift?.status === "dayOff" && <span>휴무</span>}
                        {showCalendarTimes && shift?.status !== "dayOff" && <small>{shift?.startTime}-{shift?.endTime}</small>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className={styles.table}>
        <div className={`${styles.row} ${styles.header}`}>
          <div className={`${styles.cell} ${styles.name}`}>직원</div>
          {weekDays.map((day) => {
            const holiday = getHoliday(day.date);
            return (
              <div
                className={`${styles.cell} ${styles.dayHeader} ${holiday ? styles.holiday : ""}`}
                key={day.weekday}
                onContextMenu={(event) => openDayContextMenu(event, day)}
              >
                <strong>{day.dayName}</strong>
                <span>{day.label}</span>
                {holiday && <em>{holiday.name}</em>}
              </div>
            );
          })}
          <div className={`${styles.cell} ${styles.total}`}>주간합계</div>
        </div>

        {members.map((member) => (
          <div className={styles.row} key={member.id}>
            <div className={`${styles.cell} ${styles.name}`}>{member.name}</div>
            {weekDays.map((day) => {
              const shift = getVisibleShift(member.id, day.weekday, day.date);
              const holiday = getHoliday(day.date);
              const memo = getMemo(member.id, day.date);
              const isDayOff = shift?.status === "dayOff";
              const shiftHours = shift && !isDayOff ? getHours(shift.startTime, shift.endTime) : 0;
              const isSelected = selected?.memberId === member.id && selected?.weekday === day.weekday && selected?.date === day.date;

              return (
                <div
                  className={`${styles.cell} ${styles.shift} ${shift ? styles.filled : ""} ${isDayOff ? styles.dayOff : ""} ${shift?.source === "override" ? styles.override : ""} ${isSelected ? styles.selected : ""}`}
                  key={day.weekday}
                  role="button"
                  tabIndex={0}
                  onClick={() => openCell(member.id, day.weekday, day.date, shift, false)}
                  onDoubleClick={() => openCell(member.id, day.weekday, day.date, shift, true)}
                  onKeyDown={(event) => { if (event.key === "Enter") openCell(member.id, day.weekday, day.date, shift, true); }}
                >
                  {memo && (
                    <button
                      className={styles.memoBadge}
                      title={memo.content}
                      onClick={(event) => { event.stopPropagation(); openCell(member.id, day.weekday, day.date, shift, true, "memo"); }}
                    >
                      📝
                    </button>
                  )}
                  {!shift && <span>+</span>}
                  {shift && isDayOff && (
                    <>
                      <strong>{shift.source === "holiday" ? "공휴일" : "휴무"}</strong>
                      {shift.source === "holiday" && holiday && <em>{holiday.name}</em>}
                      {showTimes && <em>기존 {shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                  {shift && !isDayOff && (
                    <>
                      <strong>{formatHours(shiftHours)}</strong>
                      {showTimes && <em>{shift.startTime}-{shift.endTime}</em>}
                    </>
                  )}
                </div>
              );
            })}
            <div className={`${styles.cell} ${styles.total}`}>{formatHours(weeklyHours(member.id))}</div>
          </div>
        ))}

        <div className={`${styles.row} ${styles.footer} ${styles.hoursFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>일 총 근무시간</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{formatHours(dailyHours(day.date))}</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>{formatHours(totalWeeklyHours)}</div>
        </div>

        <div className={`${styles.row} ${styles.footer} ${styles.peopleFooter}`}>
          <div className={`${styles.cell} ${styles.name}`}>출근 인원</div>
          {weekDays.map((day) => (
            <div className={`${styles.cell} ${styles.total}`} key={day.weekday}>{dailyWorkerCount(day.date)}명</div>
          ))}
          <div className={`${styles.cell} ${styles.total}`}>-</div>
        </div>
      </section>

      {dayContextMenu && (
        <div
          className={styles.dayContextMenu}
          onClick={(event) => event.stopPropagation()}
          style={{ left: dayContextMenu.x, top: dayContextMenu.y }}
        >
          <strong>{dayContextMenu.dayName} {dayContextMenu.label}</strong>
          <button onClick={markDateOff}>휴무일 지정</button>
        </div>
      )}

      {selected && isEditorOpen && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h2>{selectedMember?.name} 날짜별 근무 수정</h2>
            <p>{selected.date} · {DAY_NAMES[selected.weekday - 1]}요일</p>

            <div className={styles.modalTabs}>
              <button className={editorTab === "shift" ? styles.active : ""} onClick={() => setEditorTab("shift")}>근무</button>
              <button className={editorTab === "memo" ? styles.active : ""} onClick={() => setEditorTab("memo")}>메모</button>
            </div>

            {editorTab === "shift" && (
              <>
                <label>
                  시작 시간
                  <select value={startTime} onChange={(e) => setStartTime(e.target.value)}>
                    {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <label>
                  종료 시간
                  <select value={endTime} onChange={(e) => setEndTime(e.target.value)}>
                    {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
                  </select>
                </label>
                <p className={styles.modalSummary}>표시: {formatHours(Math.max(0, getHours(startTime, endTime)))}</p>
                <div className={styles.shortcutHint}>셀 선택 후 Ctrl+C 복사 · Ctrl+V 붙여넣기 · Delete 삭제</div>
                <div className={styles.actions}>
                  <button onClick={saveShift}>이 날짜만 저장</button>
                  {selectedShift && selectedShift.status !== "dayOff" && <button onClick={markDayOff}>이 날짜만 휴무</button>}
                  {selectedShift?.source === "override" && <button onClick={restoreDate}>날짜 예외 해제</button>}
                  {selectedShift && <button onClick={deleteShift}>삭제</button>}
                  <button onClick={() => setIsEditorOpen(false)}>닫기</button>
                </div>
              </>
            )}

            {editorTab === "memo" && (
              <>
                <label>
                  메모
                  <textarea
                    placeholder="예: 30분 일찍 퇴근, 10시에 출근"
                    value={memoDraft}
                    onChange={(e) => setMemoDraft(e.target.value)}
                  />
                </label>
                <div className={styles.actions}>
                  <button onClick={saveMemo}>메모 저장</button>
                  {getMemo(selected.memberId, selected.date) && <button onClick={deleteMemo}>메모 삭제</button>}
                  <button onClick={() => setIsEditorOpen(false)}>닫기</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify no build/lint errors**

Run: `npm run lint`
Expected: no errors reported for `src/components/Attendance/ScheduleTab.jsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/Attendance/ScheduleTab.jsx
git commit -m "feat: complete ScheduleTab (edit modal, copy/paste, day-off menu, fixed managers, calendar)"
```

---

### Task 9: Frontend — wire `ScheduleTab` into `AttendanceAdminPage.jsx`

**Files:**
- Modify: `src/components/Attendance/AttendanceAdminPage.jsx:1-16` (imports + tab state comment)
- Modify: `src/components/Attendance/AttendanceAdminPage.jsx:519-539` (tab bar)
- Modify: `src/components/Attendance/AttendanceAdminPage.jsx:687-688` (tab content, right after the salary tab's closing `</>`)

**Interfaces:**
- Consumes: `ScheduleTab` (Task 7+8) — `<ScheduleTab pin={pin} members={members} />`.

- [ ] **Step 1: Import `ScheduleTab`**

Find (currently lines 1-3):

```jsx
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';
```

Replace with:

```jsx
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import styles from './AttendanceAdminPage.module.css';
import { COLLAB_API_BASE } from '../../lib/api';
import ScheduleTab from './ScheduleTab';
```

- [ ] **Step 2: Add the 4th tab button**

Find (currently lines 519-539):

```jsx
        {/* 탭 */}
        <div className={styles.tabBar}>
          <button
            className={`${styles.tabBtn} ${tab === 'members' ? styles.tabActive : ''}`}
            onClick={() => setTab('members')}
          >
            👥 직원 관리
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'records' ? styles.tabActive : ''}`}
            onClick={() => setTab('records')}
          >
            📋 출퇴근 기록
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'salary' ? styles.tabActive : ''}`}
            onClick={() => setTab('salary')}
          >
            💰 급여명세서
          </button>
        </div>
```

Replace with:

```jsx
        {/* 탭 */}
        <div className={styles.tabBar}>
          <button
            className={`${styles.tabBtn} ${tab === 'members' ? styles.tabActive : ''}`}
            onClick={() => setTab('members')}
          >
            👥 직원 관리
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'records' ? styles.tabActive : ''}`}
            onClick={() => setTab('records')}
          >
            📋 출퇴근 기록
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'salary' ? styles.tabActive : ''}`}
            onClick={() => setTab('salary')}
          >
            💰 급여명세서
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'schedule' ? styles.tabActive : ''}`}
            onClick={() => setTab('schedule')}
          >
            📅 스케줄관리
          </button>
        </div>
```

- [ ] **Step 3: Render `ScheduleTab` for the new tab**

Find the end of the salary tab block (currently lines 687-688):

```jsx
          </>
        )}
      </div>
```

Replace with:

```jsx
          </>
        )}
        {/* ── 스케줄관리 탭 ── */}
        {tab === 'schedule' && <ScheduleTab pin={pin} members={members} />}
      </div>
```

- [ ] **Step 4: Verify no build/lint errors**

Run: `npm run lint`
Expected: no errors reported for `src/components/Attendance/AttendanceAdminPage.jsx` or `ScheduleTab.jsx`.

- [ ] **Step 5: Full manual browser verification**

1. Start both servers:
   ```bash
   cd backend
   uvicorn main:app --reload --host 127.0.0.1 --port 8000
   ```
   ```bash
   npm run dev
   ```
   (Confirm `COLLAB_API_BASE` in your `.env`/`vite` config points at this same backend, or start `collab_app.py` instead per `CLAUDE.md` if your local setup runs the collab server separately.)
2. Navigate to `/attendance` (or wherever `AttendanceAdminPage` is mounted), enter PIN `1234`.
3. In "직원 관리", confirm at least 2-3 test employees exist (add some if not).
4. Click "📅 스케줄관리" — confirm the weekly grid renders with a row per employee and 5 day columns, no console errors.
5. Click an empty cell — a modal opens on the "근무" tab. Set 09:00-14:00 and click "이 날짜만 저장" — confirm the modal closes and the cell now shows "5.0h".
6. Reload the page, go back to 스케줄관리 — confirm the same cell still shows "5.0h" (proves server persistence, not just local state).
7. Click the same cell again, click "이 날짜만 휴무" — confirm it turns into a "휴무" cell styled in red.
8. Click "날짜 예외 해제" — confirm it reverts (disappears, since no fixed rule exists yet for that weekday).
9. Right-click a day-of-week header — confirm a small menu appears with "휴무일 지정"; click it — confirm every employee row shows "휴무" for that day.
10. Select a filled cell, press Ctrl+C, select a different empty cell, press Ctrl+V — confirm the same time range is pasted in. Select it and press Delete — confirm it clears.
11. Click a cell, switch to the "메모" tab, type a note, save — confirm a small 📝 badge appears on that cell; reload and confirm the memo persists.
12. Click "고정날짜 변경", pick an employee, click "수정", toggle on 월/수/금, save — confirm those weekdays now show a recurring shift in the current and future weeks (navigate "다음 주" to check).
13. Try to make one employee exceed 15h/week (e.g., set 5 days × 4h via 고정날짜/고정시간, or several individual overrides) — confirm an inline red error message appears (not a browser `alert()`) and the change is rejected.
14. Click "캘린더 보기", select an employee and a month — confirm the monthly grid shows their scheduled/day-off days.
15. Go back to "직원 관리", delete a test employee who has schedule data — confirm no errors, and their row disappears from the schedule grid on next view.

- [ ] **Step 6: Commit**

```bash
git add src/components/Attendance/AttendanceAdminPage.jsx
git commit -m "feat: add schedule management tab to attendance admin page"
```

---

## Self-Review Notes

- **Spec coverage:** schema/cascade (Task 1), combined read (Task 2), fixed-rules bulk + 15h cap (Task 3), overrides + 15h cap (Task 4), memos (Task 5), CSS (Task 6), full component incl. grid/modal/copy-paste/context-menu/fixed managers/calendar (Tasks 7-8), wiring + no-`alert` policy verified in manual steps (Task 9). All spec sections are covered.
- **Type/name consistency checked:** `memberId`/`startTime`/`endTime`/`effectiveFrom`/`weekday`/`status`/`date`/`content` used identically across all backend endpoints and all frontend functions; `_fixed_rule_row_to_dict`/`_override_row_to_dict`/`_memo_row_to_dict` names match between Task 2 (definition) and Tasks 3-5 (usage); `_hours_between` defined in Task 3, reused in Task 4 without redefinition — confirmed it's added only once, in Task 3.
- **No placeholders:** all steps include complete, runnable code; no "TBD"/"similar to Task N" shortcuts.
