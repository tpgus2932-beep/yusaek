# 입고대기 DB 이관 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노예김승일 "입고대기설정" 기능이 참조하던 두 개의 엑셀 파일(`원가베이스유.xlsx` Sheet2, `입고대기.xlsx`)을 SQLite DB 테이블 하나(`입고대기`)로 통합 이관하고, DB관리 화면에서 그 테이블을 직접 관리할 수 있게 한다.

**Architecture:** 기존 `원가베이스유.db`(WONBE_DB_PATH)에 `입고대기` 테이블을 새로 추가한다(`backend/api/wonbe_routes.py`의 `_get_wonbe_db()` 재사용). `backend/api/misong_routes.py`의 입고대기 관련 3개 엔드포인트(`/waiting-base/download`, `/waiting-base/append`, `/waiting-base/export-to-ezadmin`)는 더 이상 엑셀 파일을 열지 않고 이 테이블을 조회/수정한다. DB관리 프런트(`src/components/DBManager/`)에는 기존 `WonbeTable.jsx`/`KdgTable.jsx`와 동일한 패턴으로 새 탭을 추가한다.

**Tech Stack:** FastAPI, sqlite3(stdlib), openpyxl/xlwt(엑셀 입출력), React(DBManager 탭), 기존 `LOCAL_API_BASE`/`getAuthHeaders` 프런트 유틸.

## Global Constraints

- 이 저장소에는 자동화 테스트 스위트가 없다(`CLAUDE.md`: "No test suite"). 이 계획은 `pytest` 대신 **개발 서버를 띄운 상태에서 `curl` 또는 `python -c`로 수동 검증**하는 절차를 사용한다.
- DB 파일 경로는 항상 `C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.db` (기존 `WONBE_DB_PATH`, 변경 없음).
- 테이블/컬럼명은 한글 그대로 사용한다 (기존 코드베이스 컨벤션: `wonbe`, `케이디지원가베이스`, `날짜별장끼정리`, `거래처계좌데이터`, `이체파일`과 동일 스타일). 새 테이블명은 `입고대기`.
- 기존 프런트(`src/components/NoyeKim/NoyeKimPage.jsx`)가 호출하는 URL 경로(`/noye-kimsungil/misong/waiting-base/download`, `/append`, `/export-to-ezadmin`)는 **절대 변경하지 않는다** — 백엔드 내부 구현만 파일→DB로 바꾼다. 이 3개 엔드포인트는 요청/응답 계약(response JSON 필드명, xls 헤더, `X-Unmatched-Count`/`X-Unmatched-Codes` 헤더)을 그대로 유지한다.
- Excel 다운로드는 기존 관례대로 `xlwt`로 `.xls` 생성, `_content_disposition()` 헬퍼 재사용.

---

## File Structure

- Modify: `backend/api/wonbe_routes.py` — `입고대기` 테이블 초기화 함수 + CRUD 라우트 5개 추가 (`/wonbe/ingodaegi/*`).
- Modify: `backend/api/misong_routes.py` — `/waiting-base/download`, `/waiting-base/append`, `/waiting-base/export-to-ezadmin` 3개 엔드포인트를 DB 기반으로 재작성. 죽은 코드(`WAITING_BASE_PATH`, `_INGODAEGI_PATH`, `_get_waiting_base_sheet1`, `SHARED_COST_BASE_PATH` import) 제거.
- Create: `src/components/DBManager/IngodaegiTable.jsx` — 새 DB관리 탭 컴포넌트 (`WonbeTable.jsx` 패턴 복사).
- Modify: `src/components/DBManager/DBManagerLayout.jsx` — `TABLES` 배열에 `입고대기` 탭 추가.

---

### Task 1: `입고대기` 테이블 + CRUD 라우트 (`backend/api/wonbe_routes.py`)

**Files:**
- Modify: `backend/api/wonbe_routes.py:29-39` (경로/컬럼 상수 영역)
- Modify: `backend/api/wonbe_routes.py:76-83` (`_init_kdg_table` 바로 아래에 `_init_ingodaegi_table` 추가)
- Modify: `backend/api/wonbe_routes.py:205-206` (`build_wonbe_router` 시작부 이후, `/init-from-default` 라우트 뒤쪽에 새 라우트 블록 삽입 — 정확히는 `wonbe_init_from_default` 함수(252-287줄) 바로 다음)

**Interfaces:**
- Produces: `_init_ingodaegi_table(conn)`, `INGODAEGI_XLSX_PATH`, `INGODAEGI_COLUMNS`. 라우트: `POST /wonbe/ingodaegi/init-from-default`, `GET /wonbe/ingodaegi/search`, `POST /wonbe/ingodaegi/append`, `DELETE /wonbe/ingodaegi/row`, `GET /wonbe/ingodaegi/export`.
- Consumes: 기존 `_get_wonbe_db()`, `_content_disposition()`.

- [ ] **Step 1: 상수 추가**

`backend/api/wonbe_routes.py:29-39`을 다음과 같이 수정 (기존 3줄 뒤에 2줄 추가):

```python
WONBE_DB_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.db")
WONBE_XLSX_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx")
JANGGI_DB_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\날짜별장끼정리.db")
INGODAEGI_XLSX_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\입고대기.xlsx")

COLUMNS = ["상품코드", "상품명", "색상", "사이즈", "원가", "거래처", "거래처상품명", "거래처합", "상품명합", "거래처주소", "옵션번호"]
EDITABLE = {"상품명합", "거래처합", "원가", "거래처주소"}

INGODAEGI_COLUMNS = ["상품코드", "입고수량"]

JANGGI_COLUMNS = ["거래처", "거래처상품명", "가격", "옵션", "사이즈", "개수", "날짜", "미송체크", "상품코드", "메모", "거래처합산"]
```

- [ ] **Step 2: 테이블 초기화 함수 추가**

`backend/api/wonbe_routes.py:76-83`의 `_init_kdg_table` 함수 바로 뒤에 삽입:

```python
def _init_ingodaegi_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS 입고대기 (
            상품코드  TEXT PRIMARY KEY,
            입고수량  TEXT NOT NULL DEFAULT 'ZERO'
        )
    """)
    conn.commit()
```

- [ ] **Step 3: CRUD 라우트 추가**

`backend/api/wonbe_routes.py`에서 `wonbe_init_from_default` 함수(252~287줄) 바로 다음, `@router.get("/search")`(289줄) 바로 앞에 아래 라우트 블록을 삽입:

```python
    # ── 입고대기 CRUD ─────────────────────────────────────────────

    @router.post("/ingodaegi/init-from-default")
    def ingodaegi_init_from_default(user: str = Depends(get_current_user)):
        if not INGODAEGI_XLSX_PATH.exists():
            raise HTTPException(status_code=404, detail=f"파일 없음: {INGODAEGI_XLSX_PATH}")
        try:
            wb = openpyxl.load_workbook(str(INGODAEGI_XLSX_PATH), read_only=True, data_only=True)
            ws = wb.active
            rows_iter = ws.iter_rows(values_only=True)
            next(rows_iter, None)  # 헤더 스킵
            data_rows = []
            for row in rows_iter:
                code = str(row[0]).strip() if row and row[0] is not None else ""
                if not code:
                    continue
                qty = str(row[1]).strip() if len(row) > 1 and row[1] is not None else "ZERO"
                data_rows.append((code, qty or "ZERO"))
            wb.close()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"파일 읽기 오류: {e}")

        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            conn.execute("DELETE FROM 입고대기")
            conn.executemany(
                "INSERT OR REPLACE INTO 입고대기 (상품코드, 입고수량) VALUES (?, ?)",
                data_rows,
            )
            conn.commit()
            return {"ok": True, "count": len(data_rows)}
        finally:
            conn.close()

    @router.get("/ingodaegi/search")
    def ingodaegi_search(
        q: str = "",
        offset: int = 0,
        limit: int = 50,
        user: str = Depends(get_current_user),
    ):
        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            q = q.strip()
            if not q:
                rows = conn.execute(
                    "SELECT * FROM 입고대기 ORDER BY 상품코드 LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
                total = conn.execute("SELECT COUNT(*) FROM 입고대기").fetchone()[0]
            else:
                like = f"%{q}%"
                rows = conn.execute(
                    "SELECT * FROM 입고대기 WHERE 상품코드 LIKE ? ORDER BY 상품코드 LIMIT ? OFFSET ?",
                    (like, limit, offset),
                ).fetchall()
                total = conn.execute(
                    "SELECT COUNT(*) FROM 입고대기 WHERE 상품코드 LIKE ?", (like,)
                ).fetchone()[0]
            return {
                "ok": True,
                "rows": [dict(r) for r in rows],
                "total": total,
                "offset": offset,
                "limit": limit,
            }
        finally:
            conn.close()

    @router.post("/ingodaegi/append")
    def ingodaegi_append(payload: dict = Body(...), user: str = Depends(get_current_user)):
        text = str(payload.get("text") or "")
        codes = []
        for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            first_cell = line.split("\t", 1)[0].strip()
            if first_cell:
                codes.append(first_cell)
        if not codes:
            raise HTTPException(status_code=400, detail="추가할 상품코드가 없습니다.")

        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            before = conn.execute("SELECT COUNT(*) FROM 입고대기").fetchone()[0]
            conn.executemany(
                "INSERT OR IGNORE INTO 입고대기 (상품코드, 입고수량) VALUES (?, 'ZERO')",
                [(c,) for c in codes],
            )
            conn.commit()
            after = conn.execute("SELECT COUNT(*) FROM 입고대기").fetchone()[0]
            return {"ok": True, "requested": len(codes), "inserted": after - before}
        finally:
            conn.close()

    @router.delete("/ingodaegi/row")
    def ingodaegi_delete_row(payload: dict = Body(...), user: str = Depends(get_current_user)):
        code = str(payload.get("상품코드") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="상품코드 필요")
        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            cur = conn.execute("DELETE FROM 입고대기 WHERE 상품코드 = ?", (code,))
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="해당 상품코드 없음")
            return {"ok": True, "deleted": cur.rowcount}
        finally:
            conn.close()

    @router.get("/ingodaegi/export")
    def ingodaegi_export(user: str = Depends(get_current_user)):
        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            rows = conn.execute("SELECT * FROM 입고대기 ORDER BY 상품코드").fetchall()
        finally:
            conn.close()

        book = xlwt.Workbook()
        sheet = book.add_sheet("Sheet1")
        for ci, h in enumerate(INGODAEGI_COLUMNS):
            sheet.write(0, ci, h)
        for ri, row in enumerate(rows, start=1):
            for ci, col in enumerate(INGODAEGI_COLUMNS):
                sheet.write(ri, ci, row[col] or "")

        buf = io.BytesIO()
        book.save(buf)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={"Content-Disposition": _content_disposition("입고대기.xls")},
        )

```

- [ ] **Step 4: 서버 재시작 후 수동 검증**

`backend/` 디렉터리에서 서버 재시작 (`uvicorn main:app --reload --host 127.0.0.1 --port 8000`), 로그인 토큰을 얻은 뒤:

```bash
curl -s -X POST http://127.0.0.1:8000/wonbe/ingodaegi/init-from-default -H "Authorization: Bearer $TOKEN"
```

Expected: `{"ok":true,"count":8308}` (또는 그 근처의 정수 — `입고대기.xlsx` 실제 행수).

```bash
curl -s "http://127.0.0.1:8000/wonbe/ingodaegi/search?q=S10456" -H "Authorization: Bearer $TOKEN"
```

Expected: `rows`에 `{"상품코드":"S10456","입고수량":"ZERO"}` 포함.

- [ ] **Step 5: Commit**

```bash
git add backend/api/wonbe_routes.py
git commit -m "feat: 입고대기 DB 테이블 및 CRUD 라우트 추가"
```

---

### Task 2: `misong_routes.py`의 입고대기 3개 엔드포인트를 DB 기반으로 전환

**Files:**
- Modify: `backend/api/misong_routes.py:1-20` (import/상수 정리)
- Modify: `backend/api/misong_routes.py:199-204` (`_get_waiting_base_sheet1` 제거)
- Modify: `backend/api/misong_routes.py:499-570` (`/waiting-base/download`)
- Modify: `backend/api/misong_routes.py:572-609` (`/waiting-base/append`)
- Modify: `backend/api/misong_routes.py:1194-1301` (`/waiting-base/export-to-ezadmin`)

**Interfaces:**
- Consumes: Task 1의 `_init_ingodaegi_table` — `from api.wonbe_routes import _init_ingodaegi_table` 추가 필요 (`_get_wonbe_db`는 이미 13줄에서 import됨).
- Produces: 변경 없음 (URL 경로, 응답 스키마 100% 동일 유지).

- [ ] **Step 1: import/상수 정리**

`backend/api/misong_routes.py:12,13,17,20`을 다음으로 교체:

```python
from api.wonbe_routes import _get_wonbe_db, _init_ingodaegi_table

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
```

(`from api.amood_hapbae import SHARED_COST_BASE_PATH`, `WAITING_BASE_PATH = SHARED_COST_BASE_PATH`, `_INGODAEGI_PATH = Path(...)` 3줄은 삭제. `from api.wonbe_routes import _get_wonbe_db as _get_wonbe_db`도 위 한 줄로 대체.)

- [ ] **Step 2: 죽은 헬퍼 제거**

`backend/api/misong_routes.py:199-204`의 `_get_waiting_base_sheet1` 함수 전체를 삭제.

- [ ] **Step 3: `/waiting-base/download`을 DB 기반으로 재작성**

`backend/api/misong_routes.py:499-570` 전체를 다음으로 교체:

```python
    @router.get("/waiting-base/download")
    def download_waiting_base(user: str = Depends(get_current_user)):
        wonbe_conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(wonbe_conn)
            base_rows = wonbe_conn.execute("SELECT 상품코드, 입고수량 FROM 입고대기 ORDER BY 상품코드").fetchall()
        finally:
            wonbe_conn.close()
        if not base_rows:
            raise HTTPException(status_code=404, detail="입고대기 테이블에 데이터가 없습니다.")

        conn = get_db()
        try:
            _init(conn)
            rows = conn.execute(
                """
                SELECT original_f, SUM(F) AS qty
                FROM misong_items
                WHERE TRIM(original_f) != ''
                GROUP BY original_f
                """
            ).fetchall()
            qty_by_code = {
                _normalize_code(row["original_f"]): int(row["qty"] or 0)
                for row in rows
                if _normalize_code(row["original_f"])
            }
        finally:
            conn.close()

        matched_codes = {r["상품코드"] for r in base_rows}

        buf = io.BytesIO()
        out_wb = xlwt.Workbook()
        out_ws = out_wb.add_sheet("Sheet1")
        out_ws.write(0, 0, "상품코드")
        out_ws.write(0, 1, "작업수량")
        for ri, r in enumerate(base_rows, start=1):
            code = r["상품코드"]
            out_ws.write(ri, 0, code)
            out_ws.write(ri, 1, qty_by_code.get(code, "ZERO"))
        out_wb.save(buf)
        buf.seek(0)

        unmatched = [code for code in qty_by_code if code not in matched_codes]
        unmatched_count = len(unmatched)
        unmatched_str = ",".join(unmatched)[:500]

        filename = "입고대기_미송수량.xls"
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.ms-excel",
            headers={
                "Content-Disposition": _content_disposition(filename),
                "X-Unmatched-Count": str(unmatched_count),
                "X-Unmatched-Codes": unmatched_str,
                "Access-Control-Expose-Headers": "X-Unmatched-Count, X-Unmatched-Codes",
            },
        )
```

- [ ] **Step 4: `/waiting-base/append`을 DB 기반으로 재작성**

`backend/api/misong_routes.py:572-609` 전체를 다음으로 교체:

```python
    @router.post("/waiting-base/append")
    def append_waiting_base(payload: dict = Body(...), user: str = Depends(get_current_user)):
        values = _parse_tsv_first_column(payload.get("text", ""))
        if not values:
            raise HTTPException(status_code=400, detail="추가할 A열 데이터가 없습니다.")

        conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(conn)
            before = conn.execute("SELECT COUNT(*) FROM 입고대기").fetchone()[0]
            conn.executemany(
                "INSERT OR IGNORE INTO 입고대기 (상품코드, 입고수량) VALUES (?, 'ZERO')",
                [(v,) for v in values],
            )
            conn.commit()
            after = conn.execute("SELECT COUNT(*) FROM 입고대기").fetchone()[0]
        finally:
            conn.close()

        return {"ok": True, "appended": after - before, "requested": len(values)}
```

- [ ] **Step 5: `/waiting-base/export-to-ezadmin`을 DB 기반으로 재작성**

`backend/api/misong_routes.py:1194-1301`에서 1221~1243줄(파일을 열어 순회하는 부분)을 다음으로 교체 (1194~1220줄의 세션 체크·미송 집계 부분과 1245줄 이후 EZAdmin 업로드 부분은 그대로 유지):

```python
        if not qty_by_code:
            return {"ok": False, "error": "미송목록이 비어 있습니다."}

        wonbe_conn = _get_wonbe_db()
        try:
            _init_ingodaegi_table(wonbe_conn)
            base_rows = wonbe_conn.execute("SELECT 상품코드, 입고수량 FROM 입고대기 ORDER BY 상품코드").fetchall()
        finally:
            wonbe_conn.close()
        if not base_rows:
            return {"ok": False, "error": "입고대기 테이블에 데이터가 없습니다."}

        out_wb = xlwt.Workbook()
        out_ws = out_wb.add_sheet("Sheet1")
        out_ws.write(0, 0, "상품코드")
        out_ws.write(0, 1, "입고수량")

        matched_count = 0
        for ri, r in enumerate(base_rows, start=1):
            code = r["상품코드"]
            cell_val = qty_by_code.get(code, r["입고수량"])
            out_ws.write(ri, 0, code)
            out_ws.write(ri, 1, cell_val)
            if code in qty_by_code:
                matched_count += 1

        buf = io.BytesIO()
        out_wb.save(buf)
        xls_bytes = buf.getvalue()
```

(원래 있던 `if not _INGODAEGI_PATH.exists(): ...`, `wb_in = openpyxl.load_workbook(...)`, `ws_in = wb_in.active`, `out_row` 관련 for 루프, `if out_row == 1: ...` 블록은 위 코드로 완전히 대체되어 삭제됨. 이어지는 `cookies = {...}` 이후 EZAdmin 업로드 로직은 변경하지 않음.)

- [ ] **Step 6: 서버 재시작 후 수동 검증**

```bash
curl -s -X POST http://127.0.0.1:8000/noye-kimsungil/misong/waiting-base/append \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"S99999\nS10456"}'
```

Expected: `{"ok":true,"appended":1,"requested":2}` (S10456은 Task 1에서 이미 넣었으므로 중복 무시, S99999만 신규 삽입).

```bash
curl -s -o /tmp/waiting.xls -D - http://127.0.0.1:8000/noye-kimsungil/misong/waiting-base/download -H "Authorization: Bearer $TOKEN" | grep -i x-unmatched
```

Expected: HTTP 200과 `X-Unmatched-Count` 헤더가 출력되고, `/tmp/waiting.xls` 파일 크기가 0이 아님.

- [ ] **Step 7: Commit**

```bash
git add backend/api/misong_routes.py
git commit -m "refactor: 입고대기 3개 엔드포인트를 엑셀 파일 대신 DB 테이블 기반으로 전환"
```

---

### Task 3: DB관리 화면에 "입고대기" 탭 추가

**Files:**
- Create: `src/components/DBManager/IngodaegiTable.jsx`
- Modify: `src/components/DBManager/DBManagerLayout.jsx:1-16`

**Interfaces:**
- Consumes: Task 1의 `/wonbe/ingodaegi/search`, `/wonbe/ingodaegi/append`, `/wonbe/ingodaegi/row` (DELETE), `/wonbe/ingodaegi/export`, `/wonbe/ingodaegi/init-from-default`.
- Produces: `IngodaegiTable` 컴포넌트(default export), `DBManagerLayout`의 `TABLES` 배열에 `{ key: "ingodaegi", label: "입고대기", component: IngodaegiTable }` 항목.

- [ ] **Step 1: `IngodaegiTable.jsx` 생성**

`src/components/DBManager/IngodaegiTable.jsx`:

```jsx
import React, { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, PlusCircle, Trash2, RotateCcw } from "lucide-react";
import styles from "./DBManager.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders } from "../../lib/api";

const PAGE_SIZE = 50;

export default function IngodaegiTable() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [inputQuery, setInputQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [appendText, setAppendText] = useState("");
  const [appending, setAppending] = useState(false);

  const fetchRows = useCallback(async (q, off) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ offset: off, limit: PAGE_SIZE });
      if (q) params.set("q", q);
      const res = await fetch(`${API}/wonbe/ingodaegi/search?${params}`, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "조회 실패");
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(query, offset); }, [fetchRows, query, offset]);

  const handleSearch = (e) => {
    e.preventDefault();
    setOffset(0);
    setQuery(inputQuery.trim());
  };

  const handleAppend = async () => {
    if (!appendText.trim()) return;
    setAppending(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ text: appendText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "추가 실패");
      setMessage(`추가 완료: 신규 ${data.inserted}건 (요청 ${data.requested}건)`);
      setAppendText("");
      setOffset(0);
      await fetchRows(query, 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setAppending(false);
    }
  };

  const handleDelete = async (code) => {
    if (!window.confirm(`${code}를 입고대기 목록에서 삭제할까요?`)) return;
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/row`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ 상품코드: code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "삭제 실패");
      setRows((prev) => prev.filter((r) => r["상품코드"] !== code));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const handleInitFromDefault = async () => {
    if (!window.confirm("입고대기.xlsx 기준으로 테이블을 초기화합니다. 기존 데이터는 모두 삭제됩니다. 진행하시겠습니까?")) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API}/wonbe/ingodaegi/init-from-default`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.detail || "초기화 실패");
      setMessage(`초기화 완료: ${data.count}행`);
      setOffset(0);
      setQuery("");
      setInputQuery("");
      await fetchRows("", 0);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    fetch(`${API}/wonbe/ingodaegi/export`, { headers: getAuthHeaders() })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "입고대기.xls";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setMessage("다운로드 실패"));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>입고대기</div>
          <div className={styles.subtitle}>노예김승일 입고대기설정이 참조하는 상품코드 목록</div>
        </div>
        <span className={styles.pill}>{total.toLocaleString()}행</span>
      </div>

      <div className={styles.controls}>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            className={styles.searchInput}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="상품코드 검색"
          />
          <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={loading}>
            검색
          </button>
        </form>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => fetchRows(query, offset)} disabled={loading}>
          <RefreshCw size={13} />새로고침
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleDownload} disabled={loading}>
          <Download size={13} />xls 내보내기
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleInitFromDefault} disabled={loading}>
          <RotateCcw size={13} />입고대기.xlsx로 초기화
        </button>
      </div>

      <div className={styles.controls}>
        <textarea
          value={appendText}
          onChange={(e) => setAppendText(e.target.value)}
          placeholder="추가할 상품코드를 한 줄에 하나씩 붙여넣으세요"
          rows={3}
          style={{ flex: 1, minWidth: "240px", fontFamily: "inherit", fontSize: "0.82rem", padding: "6px 8px" }}
        />
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleAppend} disabled={appending || !appendText.trim()}>
          <PlusCircle size={13} />{appending ? "추가 중..." : "추가"}
        </button>
      </div>

      {message && <div className={styles.message}>{message}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>상품코드</th>
              <th>입고수량</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row["상품코드"]}>
                <td>{row["상품코드"]}</td>
                <td>{row["입고수량"]}</td>
                <td>
                  <button
                    className={`${styles.btn} ${styles.btnSecondary}`}
                    onClick={() => handleDelete(row["상품코드"])}
                    title="삭제"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && <div className={styles.empty}>조회된 데이터가 없습니다.</div>}
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>이전</button>
          <span>{currentPage} / {totalPages}</span>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setOffset(offset + PAGE_SIZE)} disabled={currentPage >= totalPages || loading}>다음</button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: `DBManagerLayout.jsx`에 탭 등록**

`src/components/DBManager/DBManagerLayout.jsx:1-16` 전체를 다음으로 교체:

```jsx
import React, { useState } from "react";
import { Database } from "lucide-react";
import styles from "./DBManager.module.css";
import WonbeTable from "./WonbeTable";
import KdgTable from "./KdgTable";
import JanggiTable from "./JanggiTable";
import AccountDataTable from "./AccountDataTable";
import IchaeTable from "./IchaeTable";
import IngodaegiTable from "./IngodaegiTable";

const TABLES = [
  { key: "wonbe", label: "원가베이스유", component: WonbeTable },
  { key: "kdg", label: "케이디지원가베이스", component: KdgTable },
  { key: "janggi", label: "날짜별장끼정리", component: JanggiTable },
  { key: "account", label: "거래처계좌데이터", component: AccountDataTable },
  { key: "ichae", label: "이체파일", component: IchaeTable },
  { key: "ingodaegi", label: "입고대기", component: IngodaegiTable },
];
```

(이하 `DBManagerLayout` 함수 본문은 변경 없음.)

- [ ] **Step 3: 브라우저 수동 확인**

`npm run dev` 실행 후 사이드메뉴 → DB관리 → "입고대기" 탭 클릭. "입고대기.xlsx로 초기화" 버튼 클릭 → 8,308행 로드 확인 → 검색창에 상품코드 일부 입력해 필터링 확인 → 텍스트박스에 신규 코드 붙여넣고 "추가" 클릭 → 목록에 반영 확인 → "xls 내보내기"로 다운로드된 파일이 열리는지 확인.

- [ ] **Step 4: Commit**

```bash
git add src/components/DBManager/IngodaegiTable.jsx src/components/DBManager/DBManagerLayout.jsx
git commit -m "feat: DB관리에 입고대기 탭 추가"
```

---

## Self-Review

**Spec coverage:**
- "db 테이블로 옮겨주고" (waiting-base Sheet2 매칭 → DB) → Task 2 Step 3/4에서 `/waiting-base/download`·`/append`가 `입고대기` 테이블을 사용하도록 전환.
- "입고대기.xlsx 이 파일도 테이블 하나 만들어서 db로 옮길게" → Task 1에서 `입고대기` 테이블 생성 + `init-from-default`로 `입고대기.xlsx` 최초 이관, Task 2 Step 5에서 `/waiting-base/export-to-ezadmin`이 그 테이블을 사용하도록 전환.
- "Sheet2와 입고대기.xlsx 통합" 결정 → 두 파일을 위한 로직을 테이블 하나(`입고대기`)로 합침 (Task 1).
- "db관리에서 입고대기라는 테이블 따로 만들어" → Task 3에서 DB관리 화면에 "입고대기" 탭 신설.

**Placeholder scan:** 모든 스텝에 실행 가능한 전체 코드/명령어 포함. TBD 없음.

**Type consistency:** `_init_ingodaegi_table`, `INGODAEGI_XLSX_PATH`, `INGODAEGI_COLUMNS` 이름이 Task 1과 Task 2에서 동일하게 사용됨. 프런트 `IngodaegiTable.jsx`가 호출하는 5개 엔드포인트 경로가 Task 1에서 정의한 경로(`/wonbe/ingodaegi/*`)와 정확히 일치.
