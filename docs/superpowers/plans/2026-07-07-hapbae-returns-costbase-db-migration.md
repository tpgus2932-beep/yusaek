# 합배송/반품 원가베이스 DB 이관 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아무드 합배송(`amood_hapbae.py`)과 반품 처리(`returns_routes.py`/`main.py`)가 각자 따로 읽고 쓰던 공유 원가베이스 엑셀 파일(`SHARED_COST_BASE_PATH`, 기본값 `C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx`)을 없애고, db관리 화면의 `원가베이스유` 테이블(`wonbe_routes.py`의 `WONBE_DB_PATH` / `wonbe` 테이블)을 두 기능 모두의 원가베이스 데이터 소스로 통합 이관한다.

**Architecture:** `wonbe_routes.py`에 원가베이스 조회/저장을 위한 공용 함수 3개(`load_wonbe_cost_base_df`, `save_wonbe_cost_base_df`, `load_wonbe_cost_base_map`)와 상태 조회 함수(`wonbe_cost_base_status`)를 추가하고, `amood_hapbae.py`와 `main.py`(반품용) 양쪽에서 이 함수들을 가져다 쓰도록 내부 헬퍼만 교체한다. 엔드포인트의 URL 경로와 응답 스키마는 "업로드(전체교체)" 계열을 제외하고 그대로 유지한다. `wonbe` 테이블은 `상품코드`가 PRIMARY KEY이므로, 저장은 항상 "상품코드 upsert" 방식으로만 하고 절대 `DELETE FROM wonbe`를 하지 않는다 — db관리가 공유하는 다른 테이블(입고대기/에이블리재고변경/케이디지원가베이스)이 참조하는 상품코드를 보존하기 위함이다. 상품코드가 빈 값인 신규 행 추가는 PRIMARY KEY 제약과 충돌하므로 명시적으로 거부한다.

**Tech Stack:** FastAPI, sqlite3(stdlib), pandas, openpyxl/xlwt(엑셀 입출력), React(AmoodHapbaePage.jsx).

## Global Constraints

- 이 저장소에는 자동화 테스트가 없다(`CLAUDE.md`: "No test suite"). 검증은 개발 서버를 띄운 상태에서 `curl`과 브라우저 수동 확인으로 한다.
- `wonbe` 테이블 스키마는 절대 변경하지 않는다: `["상품코드","상품명","색상","사이즈","원가","거래처","거래처상품명","거래처합","상품명합","거래처주소","옵션번호"]` (`상품코드` PRIMARY KEY).
- 원가베이스 매칭 키는 항상 `상품명합`(I열 자리, index 8) → 값은 `상품코드`(A열 자리, index 0). 정규화는 공백 정리 후 `.casefold()`로 통일한다 (기존 `amood_hapbae.py`의 `_ah_normalize_match_key` 관례를 따름).
- `wonbe` 테이블에 대해 어떤 경로로도 `DELETE FROM wonbe` 또는 전체 테이블 재작성을 하지 않는다. 저장은 항상 `INSERT OR REPLACE` (상품코드 upsert)만 사용한다.
- 상품코드가 빈 값인 행은 저장 시 조용히 스킵하고(`save_wonbe_cost_base_df`가 스킵 개수를 반환), 신규 행 추가(add-row) API는 상품코드가 없으면 400 에러로 명시 거부한다.
- "원가베이스 업로드(전체교체)" 기능은 아무드 합배송/반품 양쪽에서 완전히 제거한다 (`/amood-hapbae/cost-base/upload`, `/returns/cost-base/upload` 엔드포인트 삭제). 신규 원가베이스 반영은 이제 db관리 페이지(`WonbeTable.jsx`)의 xlsx 임포트/이지어드민 동기화 기능을 통해서만 한다.
- URL 경로와 JSON 응답 필드명은 위 업로드 삭제를 제외하고 100% 유지한다 (프런트 나머지 기능이 깨지지 않도록).
- 제주 합배송(`jeju_hapbae.py`)은 읽기 전용 소비자이므로 코드 변경은 "존재 여부 체크 대상"을 DB로 바꾸는 것 외에는 없다.

---

## File Structure

- Modify: `backend/api/wonbe_routes.py` — 파일 상단에 `pandas` import 추가, `_init_wonbe_table` 바로 뒤에 원가베이스 공용 함수 4개 추가.
- Modify: `backend/api/amood_hapbae.py` — 원가베이스 로드/저장/상태 함수를 DB 기반으로 교체, `/amood-hapbae/cost-base/upload` 삭제, `add-row`에 상품코드 필수 검증 추가, `append-upload` 필터를 상품코드 필수로 변경, `download`을 DB에서 즉석 생성으로 재작성, conflicts/export/send-to-ezadmin의 파일 존재 체크를 DB 존재 체크로 교체.
- Modify: `backend/api/jeju_hapbae.py` — `SHARED_COST_BASE_PATH.exists()` 4곳을 `WONBE_DB_PATH.exists()`로 교체, import 정리.
- Modify: `backend/main.py` — `_load_cost_base_df`/`_save_cost_base_df`/`_load_return_cost_base`를 DB 기반으로 교체, `RETURN_COST_BASE_CACHE` 제거, `ReturnState(SHARED_COST_BASE_PATH)` → `ReturnState(WONBE_DB_PATH)`, `build_returns_router` 호출부에서 `return_cost_base_path` 제거.
- Modify: `backend/api/returns_routes.py` — `/returns/cost-base/upload` 삭제, `/returns/cost-base/download`을 DB에서 즉석 생성으로 재작성, `add-row`에 상품코드 필수 검증 추가, `build_returns_router` 시그니처에서 `return_cost_base_path` 파라미터 제거.
- Modify: `backend/services/returns_utils.py` — `_normalize_key`를 `.lower()` 대신 `.casefold()`로 통일.
- Modify: `src/components/Barcode/AmoodHapbaePage.jsx` — 원가베이스 업로드 버튼/파일 입력/관련 state·핸들러 제거.

---

### Task 1: `wonbe_routes.py`에 원가베이스 공용 DB 헬퍼 추가

**Files:**
- Modify: `backend/api/wonbe_routes.py:1-15` (import 영역)
- Modify: `backend/api/wonbe_routes.py:74-99` (`_get_wonbe_db`/`_init_wonbe_table` 바로 뒤)

**Interfaces:**
- Produces: `load_wonbe_cost_base_df() -> pd.DataFrame`, `save_wonbe_cost_base_df(df: pd.DataFrame) -> int`(스킵된 빈 상품코드 행 수 반환), `load_wonbe_cost_base_map() -> dict[str, str]`, `wonbe_cost_base_status() -> dict`, 상수 `COST_BASE_CODE_COL = 0`, `COST_BASE_MATCH_COL = 8`.
- Consumes: 기존 `_get_wonbe_db()`, `_init_wonbe_table()`, `COLUMNS`, `WONBE_DB_PATH`.

- [ ] **Step 1: pandas import 추가**

`backend/api/wonbe_routes.py`의 현재 1~15줄:

```python
from __future__ import annotations

import io
import re
import sqlite3
import urllib.parse
from datetime import datetime
from pathlib import Path

import httpx
import openpyxl
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
```

다음으로 교체 (`pandas` 한 줄 추가):

```python
from __future__ import annotations

import io
import re
import sqlite3
import urllib.parse
from datetime import datetime
from pathlib import Path

import httpx
import openpyxl
import pandas as pd
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
```

- [ ] **Step 2: 원가베이스 공용 함수 추가**

`backend/api/wonbe_routes.py`에서 `_init_wonbe_table` 함수(74~89줄)가 끝나고 `_init_kdg_table` 함수(101줄)가 시작되기 전, 다음 블록을 삽입:

```python
COST_BASE_CODE_COL = 0
COST_BASE_MATCH_COL = 8


def _normalize_cost_base_key(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def load_wonbe_cost_base_df() -> pd.DataFrame:
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        rows = conn.execute(
            f"SELECT {', '.join(COLUMNS)} FROM wonbe ORDER BY rowid ASC"
        ).fetchall()
    finally:
        conn.close()
    return pd.DataFrame([dict(r) for r in rows], columns=COLUMNS)


def save_wonbe_cost_base_df(df: pd.DataFrame) -> int:
    """상품코드 기준 upsert. wonbe 테이블을 절대 비우지 않는다.
    상품코드가 빈 행은 PRIMARY KEY 충돌(빈 문자열끼리 덮어씀)을 피하기 위해 스킵하고,
    스킵된 행 수를 반환한다."""
    df = df.reindex(columns=COLUMNS, fill_value="").fillna("")
    codes = df[COLUMNS[COST_BASE_CODE_COL]].astype(str).str.strip()
    skipped = int((codes == "").sum())
    df = df[codes != ""]
    rows = [tuple(r) for r in df[COLUMNS].itertuples(index=False, name=None)]
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        if rows:
            conn.executemany(
                f"INSERT OR REPLACE INTO wonbe ({', '.join(COLUMNS)}) VALUES ({', '.join(['?'] * len(COLUMNS))})",
                rows,
            )
            conn.commit()
    finally:
        conn.close()
    return skipped


def load_wonbe_cost_base_map() -> dict[str, str]:
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        rows = conn.execute("SELECT 상품코드, 상품명합 FROM wonbe").fetchall()
    finally:
        conn.close()
    cost_map: dict[str, str] = {}
    for r in rows:
        key = _normalize_cost_base_key(r["상품명합"])
        if not key or key in cost_map:
            continue
        cost_map[key] = r["상품코드"]
    return cost_map


def wonbe_cost_base_status() -> dict:
    exists = WONBE_DB_PATH.exists()
    mtime = None
    if exists:
        try:
            mtime = datetime.fromtimestamp(WONBE_DB_PATH.stat().st_mtime).isoformat()
        except Exception:
            mtime = None
    conn = _get_wonbe_db()
    try:
        _init_wonbe_table(conn)
        count = conn.execute("SELECT COUNT(*) FROM wonbe").fetchone()[0]
    finally:
        conn.close()
    return {"path": str(WONBE_DB_PATH), "exists": exists, "mtime": mtime, "rows": count}

```

- [ ] **Step 3: 서버 기동 확인**

`backend/` 디렉터리에서:

```bash
python -c "from api.wonbe_routes import load_wonbe_cost_base_df, save_wonbe_cost_base_df, load_wonbe_cost_base_map, wonbe_cost_base_status; print(wonbe_cost_base_status())"
```

Expected: 에러 없이 `{'path': '...원가베이스유.db', 'exists': True, 'mtime': '...', 'rows': <정수>}` 형태 출력.

- [ ] **Step 4: Commit**

```bash
git add backend/api/wonbe_routes.py
git commit -m "feat: wonbe 테이블 기반 원가베이스 공용 헬퍼 추가"
```

---

### Task 2: `amood_hapbae.py`를 DB 기반 원가베이스로 전환

**Files:**
- Modify: `backend/api/amood_hapbae.py:1-50` (import/상수 영역)
- Modify: `backend/api/amood_hapbae.py:212-273` (`_ah_load_base_cost_map`, `_ah_load_cost_base_df`, `_ah_save_cost_base_df`, `_ah_cost_base_status`)
- Modify: `backend/api/amood_hapbae.py:376-489` (`/cost-base/upload` 삭제, `/cost-base/append-upload` 필터 수정, `/cost-base/download` 재작성)
- Modify: `backend/api/amood_hapbae.py:457-481` (`/cost-base/append-tsv`)
- Modify: `backend/api/amood_hapbae.py:572-603` (`/cost-base/add-row`)
- Modify: `backend/api/amood_hapbae.py:606-664` (`/conflicts`)
- Modify: `backend/api/amood_hapbae.py:667-745` (`/export`)
- Modify: `backend/api/amood_hapbae.py:884-940` (`/send-to-ezadmin`)

**Interfaces:**
- Consumes: Task 1의 `load_wonbe_cost_base_df`, `save_wonbe_cost_base_df`, `load_wonbe_cost_base_map`, `wonbe_cost_base_status`, `WONBE_DB_PATH` (모두 `api.wonbe_routes`에서 import).
- Produces: 변경 없음 (URL 경로/응답 필드는 `/cost-base/upload` 삭제 외 100% 동일 유지). `_ah_load_base_cost_map()`는 인자 없이도 호출 가능하도록 시그니처 변경(기존 호출부 `_ah_load_base_cost_map(path)` 형태와 하위 호환 유지— `path` 인자를 받아도 무시함).

- [ ] **Step 1: import 추가**

`backend/api/amood_hapbae.py` 20줄(`from services.cost_base_append import append_tsv_rows_to_excel`) 바로 뒤에 추가:

```python
from api.wonbe_routes import (
    WONBE_DB_PATH,
    load_wonbe_cost_base_df,
    load_wonbe_cost_base_map,
    save_wonbe_cost_base_df,
    wonbe_cost_base_status,
)
```

- [ ] **Step 2: 원가베이스 로드/저장/상태 함수를 DB 기반으로 교체**

`backend/api/amood_hapbae.py:212-273`의 다음 5개 함수(`_ah_load_base_cost_map`, `_ah_load_cost_base_df`, `_ah_save_cost_base_df`, `_ah_cost_base_status`, 그리고 이 사이의 `AMOOD_HAPBAE_COST_BASE_CACHE` 전역 변수 사용)를 찾는다:

```python
def _ah_load_base_cost_map(path: Path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    cost_map: dict[str, object] = {}
    for r in range(1, ws.max_row + 1):
        key = _ah_normalize_match_key(ws.cell(row=r, column=COST_BASE_MATCH_COL + 1).value)
        val = ws.cell(row=r, column=COST_BASE_CODE_COL + 1).value
        if key == "":
            continue
        if key not in cost_map:
            cost_map[key] = val
    return cost_map
```

이 함수를 다음으로 교체 (파일 경로 인자는 하위 호환을 위해 받되 무시한다 — `jeju_hapbae.py`가 `_ah_load_base_cost_map(SHARED_COST_BASE_PATH)` 형태로 호출 중이며 Task 3 이전까지는 그대로 둬야 하기 때문):

```python
def _ah_load_base_cost_map(_path=None):
    return load_wonbe_cost_base_map()
```

이어서 `_ah_load_cost_base_df`, `_ah_save_cost_base_df`, `_ah_cost_base_status` (238~273줄, `AMOOD_HAPBAE_COST_BASE_CACHE` 전역 변수 포함):

```python
def _ah_load_cost_base_df():
    path = SHARED_COST_BASE_PATH
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    mtime = path.stat().st_mtime
    cached_path = AMOOD_HAPBAE_COST_BASE_CACHE.get("path")
    cached_mtime = AMOOD_HAPBAE_COST_BASE_CACHE.get("mtime")
    if AMOOD_HAPBAE_COST_BASE_CACHE.get("df") is not None and cached_path == str(path) and cached_mtime == mtime:
        return AMOOD_HAPBAE_COST_BASE_CACHE["df"]
    df = _ah_read_cost_base_df(path)
    AMOOD_HAPBAE_COST_BASE_CACHE["df"] = df
    AMOOD_HAPBAE_COST_BASE_CACHE["mtime"] = mtime
    AMOOD_HAPBAE_COST_BASE_CACHE["path"] = str(path)
    return df


def _ah_save_cost_base_df(df: pd.DataFrame):
    path = SHARED_COST_BASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    AMOOD_HAPBAE_COST_BASE_CACHE["df"] = df
    AMOOD_HAPBAE_COST_BASE_CACHE["mtime"] = path.stat().st_mtime
    AMOOD_HAPBAE_COST_BASE_CACHE["path"] = str(path)


def _ah_cost_base_status() -> dict:
    path = SHARED_COST_BASE_PATH
    exists = path.exists()
    mtime = None
    if exists:
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
        except Exception:
            mtime = None
    return {"path": str(path), "exists": exists, "mtime": mtime}
```

다음으로 교체:

```python
def _ah_load_cost_base_df():
    return load_wonbe_cost_base_df()


def _ah_save_cost_base_df(df: pd.DataFrame):
    save_wonbe_cost_base_df(df)


def _ah_cost_base_status() -> dict:
    return wonbe_cost_base_status()
```

그리고 파일에서 `AMOOD_HAPBAE_COST_BASE_CACHE: dict[str, object] = {"df": None, "mtime": None, "path": None}` 선언 줄(50번째 줄 부근, `SHARED_COST_BASE_PATH = Path(...)` 블록 바로 뒤)을 삭제한다 (더 이상 쓰이지 않음).

- [ ] **Step 3: `/amood-hapbae/cost-base/upload` 엔드포인트 삭제**

`backend/api/amood_hapbae.py:376-399`의 다음 엔드포인트 전체를 삭제:

```python
@router.post("/amood-hapbae/cost-base/upload")
async def amood_hapbae_cost_base_upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in AMOOD_HAPBAE_ALLOWED_COST_BASE:
        raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

    SHARED_COST_BASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(tempfile.gettempdir()) / f"amood_hapbae_cost_base_{uuid.uuid4().hex}{ext}"
    data = await file.read()
    tmp_path.write_bytes(data)

    try:
        df = _ah_read_cost_base_df(tmp_path)
        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")
        shutil.move(str(tmp_path), str(SHARED_COST_BASE_PATH))
        _ah_load_cost_base_df()
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    return {"ok": True, "status": _ah_cost_base_status()}
```

- [ ] **Step 4: `/amood-hapbae/cost-base/append-upload`가 상품코드 없는 행을 스킵하도록 필터 변경**

`backend/api/amood_hapbae.py`의 `amood_hapbae_cost_base_append_upload` 함수 안에서 다음 부분을 찾는다:

```python
        append_df = src_df.iloc[:, :COST_BASE_REQUIRED_COLS].copy()
        append_df.columns = list(dst_df.columns[:COST_BASE_REQUIRED_COLS])
        append_df = append_df.fillna("")
        append_df = append_df[
            (append_df.iloc[:, COST_BASE_CODE_COL].astype(str).str.strip() != "") | (append_df.iloc[:, COST_BASE_MATCH_COL].astype(str).str.strip() != "")
        ].reset_index(drop=True)

        if append_df.empty:
            raise HTTPException(status_code=400, detail="추가할 데이터가 없습니다. (A/I열 확인)")
```

다음으로 교체 (OR 조건 → 상품코드 필수):

```python
        append_df = src_df.iloc[:, :COST_BASE_REQUIRED_COLS].copy()
        append_df.columns = list(dst_df.columns[:COST_BASE_REQUIRED_COLS])
        append_df = append_df.fillna("")
        append_df = append_df[
            append_df.iloc[:, COST_BASE_CODE_COL].astype(str).str.strip() != ""
        ].reset_index(drop=True)

        if append_df.empty:
            raise HTTPException(status_code=400, detail="추가할 데이터가 없습니다. (A열 상품코드가 있는 행이 없음)")
```

- [ ] **Step 5: `/amood-hapbae/cost-base/append-tsv`가 DB를 직접 읽도록 수정**

`backend/api/amood_hapbae.py:457-481`의 `amood_hapbae_cost_base_append_tsv` 함수에서 다음 부분을 찾는다:

```python
    try:
        result = append_tsv_rows_to_excel(
            SHARED_COST_BASE_PATH,
            raw_text,
            read_df=_ah_read_cost_base_df,
            save_df=_ah_save_cost_base_df,
            required_columns=COST_BASE_REQUIRED_COLS,
            append_columns=2,
            target_column_indices=[COST_BASE_CODE_COL, COST_BASE_MATCH_COL],
            skip_header=skip_header,
        )
        status = _ah_cost_base_status()
```

다음으로 교체:

```python
    try:
        result = append_tsv_rows_to_excel(
            WONBE_DB_PATH,
            raw_text,
            read_df=lambda _path: load_wonbe_cost_base_df(),
            save_df=_ah_save_cost_base_df,
            required_columns=COST_BASE_REQUIRED_COLS,
            append_columns=2,
            target_column_indices=[COST_BASE_CODE_COL, COST_BASE_MATCH_COL],
            skip_header=skip_header,
        )
        status = _ah_cost_base_status()
```

- [ ] **Step 6: `/amood-hapbae/cost-base/download`을 DB에서 즉석 생성하도록 재작성**

`backend/api/amood_hapbae.py:484-489`의 다음 엔드포인트:

```python
@router.get("/amood-hapbae/cost-base/download")
def amood_hapbae_cost_base_download():
    path = SHARED_COST_BASE_PATH
    if not path.exists():
        raise HTTPException(status_code=404, detail="원가베이스 파일이 없습니다.")
    return FileResponse(path, filename=path.name)
```

다음으로 교체:

```python
@router.get("/amood-hapbae/cost-base/download")
def amood_hapbae_cost_base_download():
    df = load_wonbe_cost_base_df()
    if df.empty:
        raise HTTPException(status_code=404, detail="원가베이스 데이터가 없습니다.")
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": _content_disposition("원가베이스유.xlsx")},
    )
```

(`io`, `pd`, `Response`, `_content_disposition`은 이미 파일 상단에서 import/정의되어 있으므로 추가 import 불필요. `FileResponse`는 다른 곳에서 계속 쓰이므로 import는 그대로 둔다.)

- [ ] **Step 7: `/amood-hapbae/cost-base/add-row`에 상품코드 필수 검증 추가**

`backend/api/amood_hapbae.py:572-577`에서 다음을 찾는다:

```python
@router.post("/amood-hapbae/cost-base/add-row")
def amood_hapbae_cost_base_add_row(payload: dict = Body(...)):
    name = _ah_normalize(payload.get("name"))
    code = _ah_normalize(payload.get("code"))
    if not name and not code:
        raise HTTPException(status_code=400, detail="A열 상품코드 또는 I열 상품명 색상 사이즈를 입력하세요.")
```

다음으로 교체:

```python
@router.post("/amood-hapbae/cost-base/add-row")
def amood_hapbae_cost_base_add_row(payload: dict = Body(...)):
    name = _ah_normalize(payload.get("name"))
    code = _ah_normalize(payload.get("code"))
    if not code:
        raise HTTPException(status_code=400, detail="A열 상품코드는 필수입니다. (상품코드 없는 행은 추가할 수 없습니다)")
```

- [ ] **Step 8: `/amood-hapbae/conflicts`의 파일 존재 체크를 DB 존재 체크로 교체**

`backend/api/amood_hapbae.py:632`에서:

```python
        cost_base_exists = SHARED_COST_BASE_PATH.exists()
```

다음으로 교체:

```python
        cost_base_exists = WONBE_DB_PATH.exists()
```

같은 함수 내 635줄 `cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)`는 `_ah_load_base_cost_map()`으로 인자 없이 호출하도록 변경 (Step 2에서 인자를 무시하도록 만들었으므로 동작은 동일하지만 가독성을 위해 정리):

```python
                cost_map = _ah_load_base_cost_map()
```

- [ ] **Step 9: `/amood-hapbae/export`의 파일 존재 체크 교체**

`backend/api/amood_hapbae.py:694-708`에서:

```python
    if not SHARED_COST_BASE_PATH.exists():
        raise HTTPException(
            status_code=400,
            detail=f"원가베이스 파일을 읽을 수 없습니다: {SHARED_COST_BASE_PATH}",
        )
```

다음으로 교체:

```python
    if not WONBE_DB_PATH.exists():
        raise HTTPException(
            status_code=400,
            detail=f"원가베이스 DB를 읽을 수 없습니다: {WONBE_DB_PATH}",
        )
```

그리고 같은 함수 내 `cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)`를 `cost_map = _ah_load_base_cost_map()`로 교체.

- [ ] **Step 10: `/amood-hapbae/send-to-ezadmin`의 존재 체크 교체**

`backend/api/amood_hapbae.py:917`에서:

```python
        cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH) if SHARED_COST_BASE_PATH.exists() else {}
```

다음으로 교체:

```python
        cost_map = _ah_load_base_cost_map() if WONBE_DB_PATH.exists() else {}
```

- [ ] **Step 11: 서버 재시작 후 수동 검증**

`backend/` 디렉터리에서 서버 재시작(`uvicorn main:app --reload --host 127.0.0.1 --port 8000`), 로그인 토큰 확보 후:

```bash
curl -s http://127.0.0.1:8000/amood-hapbae/cost-base/status -H "Authorization: Bearer $TOKEN"
```

Expected: `{"ok":true,"status":{"path":"...원가베이스유.db","exists":true,"mtime":"...","rows":<정수>}}` — db관리 `원가베이스유` 테이블의 행 수와 일치.

```bash
curl -s "http://127.0.0.1:8000/amood-hapbae/cost-base/preview?offset=0&limit=5" -H "Authorization: Bearer $TOKEN"
```

Expected: `rows`에 db관리 WonbeTable에서 보이는 것과 동일한 상품코드/상품명합 값이 나옴.

```bash
curl -s -X POST http://127.0.0.1:8000/amood-hapbae/cost-base/add-row \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"테스트상품 M","code":""}'
```

Expected: HTTP 400, `{"detail":"A열 상품코드는 필수입니다. (상품코드 없는 행은 추가할 수 없습니다)"}`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/amood-hapbae/cost-base/upload
```

Expected: `405` 또는 `404` (엔드포인트가 더 이상 존재하지 않음).

- [ ] **Step 12: Commit**

```bash
git add backend/api/amood_hapbae.py
git commit -m "refactor: 아무드 합배송 원가베이스를 wonbe DB 테이블 기반으로 전환, 업로드 기능 제거"
```

---

### Task 3: `jeju_hapbae.py`의 존재 체크를 DB 기준으로 정정

**Files:**
- Modify: `backend/api/jeju_hapbae.py:19-24` (import)
- Modify: `backend/api/jeju_hapbae.py:328,330,334` (`/jeju-hapbae/...` 첫 번째 위치)
- Modify: `backend/api/jeju_hapbae.py:383,385`
- Modify: `backend/api/jeju_hapbae.py:533,535`
- Modify: `backend/api/jeju_hapbae.py:679,681`

**Interfaces:**
- Consumes: Task 2에서 시그니처가 `_ah_load_base_cost_map(_path=None)`로 바뀐 함수, `api.wonbe_routes`의 `WONBE_DB_PATH`.
- Produces: 변경 없음 (엔드포인트 동작은 "존재하면 DB에서 매칭" 그대로, 다만 존재 체크 대상이 이제 실제 데이터 소스와 일치).

**배경:** Task 2에서 `_ah_load_base_cost_map`이 인자를 무시하고 항상 wonbe DB를 읽도록 바뀌었다. 하지만 `jeju_hapbae.py`는 여전히 `SHARED_COST_BASE_PATH.exists()`(이제는 갱신되지 않는 낡은 엑셀 파일의 존재 여부)로 "매칭을 시도할지" 판단하고 있어, DB에는 데이터가 있는데 엑셀 파일이 없으면 매칭을 건너뛰는 버그가 생긴다. 이를 고쳐야 한다.

- [ ] **Step 1: import 교체**

`backend/api/jeju_hapbae.py:19-24`의 현재 코드:

```python
from api.amood_hapbae import (
    SHARED_COST_BASE_PATH,
    _ah_load_base_cost_map,
    _ah_normalize,
    _content_disposition,
)
```

다음으로 교체:

```python
from api.amood_hapbae import (
    _ah_load_base_cost_map,
    _ah_normalize,
    _content_disposition,
)
from api.wonbe_routes import WONBE_DB_PATH
```

- [ ] **Step 2: 4곳의 존재 체크/호출 교체**

`backend/api/jeju_hapbae.py:328-334`의 현재 코드:

```python
        cost_map: dict = {}
        if SHARED_COST_BASE_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)
            except Exception:
                cost_map = {}
        unmatched = _jeju_find_unmatched(rows, cost_map)
        return {"ok": True, "unmatched": unmatched, "cost_base_exists": SHARED_COST_BASE_PATH.exists()}
```

다음으로 교체:

```python
        cost_map: dict = {}
        if WONBE_DB_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map()
            except Exception:
                cost_map = {}
        unmatched = _jeju_find_unmatched(rows, cost_map)
        return {"ok": True, "unmatched": unmatched, "cost_base_exists": WONBE_DB_PATH.exists()}
```

`backend/api/jeju_hapbae.py:382-387`의 현재 코드:

```python
        cost_map: dict = {}
        if SHARED_COST_BASE_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)
            except Exception:
                cost_map = {}
```

다음으로 교체 (이 블록이 파일에 2번 나오므로, Step 2/3/4 각각 해당 줄 번호 기준으로 적용):

```python
        cost_map: dict = {}
        if WONBE_DB_PATH.exists():
            try:
                cost_map = _ah_load_base_cost_map()
            except Exception:
                cost_map = {}
```

`backend/api/jeju_hapbae.py:532-537`의 현재 코드:

```python
    cost_map: dict = {}
    if SHARED_COST_BASE_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)
        except Exception:
            cost_map = {}
```

다음으로 교체:

```python
    cost_map: dict = {}
    if WONBE_DB_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map()
        except Exception:
            cost_map = {}
```

`backend/api/jeju_hapbae.py:678-683`의 현재 코드:

```python
    cost_map: dict = {}
    if SHARED_COST_BASE_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map(SHARED_COST_BASE_PATH)
        except Exception:
            pass
```

다음으로 교체:

```python
    cost_map: dict = {}
    if WONBE_DB_PATH.exists():
        try:
            cost_map = _ah_load_base_cost_map()
        except Exception:
            pass
```

- [ ] **Step 3: 서버 재시작 후 확인**

```bash
python -c "import ast; ast.parse(open('backend/api/jeju_hapbae.py', encoding='utf-8').read())"
```

Expected: 에러 없음 (문법 오류 없음 확인).

서버 재시작 후 제주 합배송 화면에서 파일 업로드 → 원가베이스 매칭 미리보기가 기존과 동일하게 동작하는지 브라우저로 확인.

- [ ] **Step 4: Commit**

```bash
git add backend/api/jeju_hapbae.py
git commit -m "fix: 제주 합배송 원가베이스 존재 체크를 wonbe DB 기준으로 정정"
```

---

### Task 4: `main.py`의 반품용 원가베이스 헬퍼를 DB 기반으로 전환

**Files:**
- Modify: `backend/main.py:34` (import)
- Modify: `backend/main.py:55` (import)
- Modify: `backend/main.py:131` (`RETURN_COST_BASE_CACHE` 제거)
- Modify: `backend/main.py:171-176` (`_get_return_state`)
- Modify: `backend/main.py:305-353` (`_load_return_cost_base`, `_load_cost_base_df`, `_save_cost_base_df`)
- Modify: `backend/main.py:1403-1429` (`build_returns_router(...)` 호출부)
- Modify: `backend/main.py:1431-1437` (`build_order_router(...)` 호출부는 그대로 두되 확인만 — Task 범위 밖, Self-Review 참고)

**Interfaces:**
- Consumes: Task 1의 `load_wonbe_cost_base_df`, `save_wonbe_cost_base_df`, `load_wonbe_cost_base_map`, `api.wonbe_routes.WONBE_DB_PATH`.
- Produces: `_load_cost_base_df`, `_save_cost_base_df`, `_load_return_cost_base`가 DB 기반으로 동작. `build_returns_router` 호출부에서 `return_cost_base_path` 인자 제거(Task 5에서 해당 파라미터 자체를 삭제하므로 짝을 맞춰야 함).

- [ ] **Step 1: import 정리**

`backend/main.py:34`의 현재 코드:

```python
from api.amood_hapbae import router as amood_hapbae_router, SHARED_COST_BASE_PATH
```

다음으로 교체:

```python
from api.amood_hapbae import router as amood_hapbae_router, SHARED_COST_BASE_PATH
from api.wonbe_routes import (
    build_wonbe_router,
    JANGGI_DB_PATH as _JANGGI_DB_PATH,
    WONBE_DB_PATH,
    load_wonbe_cost_base_df,
    save_wonbe_cost_base_df,
    load_wonbe_cost_base_map,
)
```

`backend/main.py:55`의 현재 코드:

```python
from api.wonbe_routes import build_wonbe_router, JANGGI_DB_PATH as _JANGGI_DB_PATH
```

이 줄은 삭제한다 (위 Step 1에서 34줄 바로 아래로 통합했으므로 중복 import 제거).

- [ ] **Step 2: `RETURN_COST_BASE_CACHE` 전역 변수 제거**

`backend/main.py:131`의 다음 줄을 삭제:

```python
RETURN_COST_BASE_CACHE: dict[str, object] = {"df": None, "mtime": None, "path": None}
```

- [ ] **Step 3: `_get_return_state`가 DB 경로로 상태를 만들도록 변경**

`backend/main.py:171-176`의 현재 코드:

```python
def _get_return_state(user: str) -> ReturnState:
    state = RETURN_STATES.get(user)
    if not state:
        state = ReturnState(SHARED_COST_BASE_PATH)
        RETURN_STATES[user] = state
    return state
```

다음으로 교체:

```python
def _get_return_state(user: str) -> ReturnState:
    state = RETURN_STATES.get(user)
    if not state:
        state = ReturnState(WONBE_DB_PATH)
        RETURN_STATES[user] = state
    return state
```

- [ ] **Step 4: 원가베이스 로드/저장 함수 3개를 DB 기반으로 교체**

`backend/main.py:305-353`의 현재 코드 (`_load_return_cost_base`, `_load_cost_base_df`, `_save_cost_base_df` 3개 함수 전체):

```python
def _load_return_cost_base(state: ReturnState):
    path = state.cost_base_path
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    cost_df = pd.read_excel(path, dtype=str)
    if cost_df.shape[1] < COST_BASE_REQUIRED_COLS:
        raise ValueError("원가베이스는 최소 A~I열이 필요합니다.")
    amap: dict[str, str] = {}
    for _, r in cost_df.iterrows():
        key_raw = r.iloc[COST_BASE_MATCH_COL] if len(r) > COST_BASE_MATCH_COL else ""
        val_raw = r.iloc[COST_BASE_CODE_COL] if len(r) > COST_BASE_CODE_COL else ""
        key = _normalize_key("" if pd.isna(key_raw) else str(key_raw))
        val = "" if pd.isna(val_raw) else str(val_raw).strip()
        if key and key not in amap:
            amap[key] = val
    state.cost_map = amap


def _load_cost_base_df():
    path = SHARED_COST_BASE_PATH
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일을 찾지 못했습니다: {path}")
    mtime = path.stat().st_mtime
    cached_path = RETURN_COST_BASE_CACHE.get("path")
    cached_mtime = RETURN_COST_BASE_CACHE.get("mtime")
    if RETURN_COST_BASE_CACHE.get("df") is not None and cached_path == str(path) and cached_mtime == mtime:
        return RETURN_COST_BASE_CACHE["df"]
    df = _read_return_excel_with_header(path, header=0)
    if df.shape[0] == 0:
        df_raw = _read_return_excel_with_header(path, header=None)
        if df_raw.shape[0] >= 2:
            new_cols = df_raw.iloc[0].fillna("").astype(str).tolist()
            df_raw = df_raw.iloc[1:].reset_index(drop=True)
            df_raw.columns = new_cols
            df = df_raw
    RETURN_COST_BASE_CACHE["df"] = df
    RETURN_COST_BASE_CACHE["mtime"] = mtime
    RETURN_COST_BASE_CACHE["path"] = str(path)
    return df


def _save_cost_base_df(df: pd.DataFrame):
    path = SHARED_COST_BASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    RETURN_COST_BASE_CACHE["df"] = df
    RETURN_COST_BASE_CACHE["mtime"] = path.stat().st_mtime
    RETURN_COST_BASE_CACHE["path"] = str(path)
```

다음으로 교체:

```python
def _load_return_cost_base(state: ReturnState):
    state.cost_map = load_wonbe_cost_base_map()


def _load_cost_base_df():
    return load_wonbe_cost_base_df()


def _save_cost_base_df(df: pd.DataFrame):
    save_wonbe_cost_base_df(df)
```

(주의: `_normalize_key`, `COST_BASE_REQUIRED_COLS`, `_read_return_excel_with_header`는 다른 곳에서 계속 쓰이므로 import/정의를 삭제하지 않는다 — `main.py` 132~134줄의 `COST_BASE_CODE_COL`/`COST_BASE_MATCH_COL`/`COST_BASE_REQUIRED_COLS`도 그대로 둔다.)

- [ ] **Step 5: `build_returns_router` 호출부에서 `return_cost_base_path` 제거**

`backend/main.py:1403-1429`의 현재 코드:

```python
    build_returns_router(
        get_current_user=_get_current_user,
        require_admin=_require_admin,
        get_return_state=_get_return_state,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        return_status=_return_status,
        return_queue_payload=_return_queue_payload,
        return_rows=_return_rows,
        return_state_to_payload=_return_state_to_payload,
        load_return_state_from_payload=_load_return_state_from_payload,
        load_return_cost_base=_load_return_cost_base,
        load_cost_base_df=_load_cost_base_df,
        save_cost_base_df=_save_cost_base_df,
        read_return_excel=_read_return_excel,
        clean_invoice=_clean_invoice,
        clean_product_name=_clean_product_name,
        lowercase_size_words=_lowercase_size_words,
        option_slash_to_space=_option_slash_to_space,
        clean_qty=_clean_qty,
        normalize_spaces=_normalize_spaces,
        reason_type=_reason_type,
        normalize_key=_normalize_key,
        content_disposition=_content_disposition,
        return_allowed_exts=RETURN_ALLOWED_EXTS,
        return_cost_base_path=SHARED_COST_BASE_PATH,
    )
)
```

다음으로 교체 (`return_cost_base_path=SHARED_COST_BASE_PATH,` 줄 삭제):

```python
    build_returns_router(
        get_current_user=_get_current_user,
        require_admin=_require_admin,
        get_return_state=_get_return_state,
        get_db=_get_shared_db,
        get_setting=_get_setting,
        return_status=_return_status,
        return_queue_payload=_return_queue_payload,
        return_rows=_return_rows,
        return_state_to_payload=_return_state_to_payload,
        load_return_state_from_payload=_load_return_state_from_payload,
        load_return_cost_base=_load_return_cost_base,
        load_cost_base_df=_load_cost_base_df,
        save_cost_base_df=_save_cost_base_df,
        read_return_excel=_read_return_excel,
        clean_invoice=_clean_invoice,
        clean_product_name=_clean_product_name,
        lowercase_size_words=_lowercase_size_words,
        option_slash_to_space=_option_slash_to_space,
        clean_qty=_clean_qty,
        normalize_spaces=_normalize_spaces,
        reason_type=_reason_type,
        normalize_key=_normalize_key,
        content_disposition=_content_disposition,
        return_allowed_exts=RETURN_ALLOWED_EXTS,
    )
)
```

- [ ] **Step 6: import 문법 확인**

```bash
python -c "import ast; ast.parse(open('backend/main.py', encoding='utf-8').read())"
```

Expected: 에러 없음. (실제 기동 확인은 Task 5 완료 후 함께 진행 — `build_returns_router`가 아직 `return_cost_base_path`를 필수 인자로 요구하는 상태라 Task 5 전까지는 서버가 기동되지 않는 것이 정상.)

- [ ] **Step 7: Commit**

```bash
git add backend/main.py
git commit -m "refactor: 반품 원가베이스 헬퍼를 wonbe DB 기반으로 전환"
```

---

### Task 5: `returns_routes.py` — 업로드 제거, 다운로드 재작성, add-row 검증 추가

**Files:**
- Modify: `backend/api/returns_routes.py:45-72` (`build_returns_router` 시그니처)
- Modify: `backend/api/returns_routes.py:767-796` (`/returns/cost-base/upload` 삭제)
- Modify: `backend/api/returns_routes.py:798-803` (`/returns/cost-base/download` 재작성)
- Modify: `backend/api/returns_routes.py:915-949` (`/returns/cost-base/add-row`)

**Interfaces:**
- Consumes: Task 4에서 `main.py`가 주입하는 `load_cost_base_df`, `save_cost_base_df`, `load_return_cost_base` (동작이 DB 기반으로 바뀜, 시그니처는 동일).
- Produces: `/returns/cost-base/upload` 삭제됨. `/returns/cost-base/download`이 DB에서 즉석 xlsx 생성. `build_returns_router`에서 `return_cost_base_path` 파라미터 제거 (Task 4 Step 5와 짝을 맞춤).

- [ ] **Step 1: `build_returns_router` 시그니처에서 `return_cost_base_path` 제거**

`backend/api/returns_routes.py:45-72`의 현재 코드:

```python
def build_returns_router(
    *,
    get_current_user,
    require_admin,
    get_return_state,
    get_db,
    get_setting,
    return_status,
    return_queue_payload,
    return_rows,
    return_state_to_payload,
    load_return_state_from_payload,
    load_return_cost_base,
    load_cost_base_df,
    save_cost_base_df,
    read_return_excel,
    clean_invoice,
    clean_product_name,
    lowercase_size_words,
    option_slash_to_space,
    clean_qty,
    normalize_spaces,
    reason_type,
    normalize_key,
    content_disposition,
    return_allowed_exts,
    return_cost_base_path,
):
```

다음으로 교체 (`return_cost_base_path,` 줄만 삭제):

```python
def build_returns_router(
    *,
    get_current_user,
    require_admin,
    get_return_state,
    get_db,
    get_setting,
    return_status,
    return_queue_payload,
    return_rows,
    return_state_to_payload,
    load_return_state_from_payload,
    load_return_cost_base,
    load_cost_base_df,
    save_cost_base_df,
    read_return_excel,
    clean_invoice,
    clean_product_name,
    lowercase_size_words,
    option_slash_to_space,
    clean_qty,
    normalize_spaces,
    reason_type,
    normalize_key,
    content_disposition,
    return_allowed_exts,
):
```

- [ ] **Step 2: `/returns/cost-base/upload` 삭제**

`backend/api/returns_routes.py:767-796`의 다음 엔드포인트 전체를 삭제:

```python
    @router.post("/returns/cost-base/upload")
    def returns_cost_base_upload(
        file: UploadFile = File(...),
        admin: str = Depends(require_admin),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        return_cost_base_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = Path(tempfile.gettempdir()) / f"returns_cost_base_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            df = read_return_excel(tmp_path)
            if df.shape[1] < COST_BASE_REQUIRED_COLS:
                raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")
            shutil.move(str(tmp_path), str(return_cost_base_path))
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        state = get_return_state(admin)
        state.cost_base_path = return_cost_base_path
        load_return_cost_base(state)

        return {"ok": True, "status": return_status(state)}
```

- [ ] **Step 3: `/returns/cost-base/download`을 DB에서 즉석 생성하도록 재작성**

`backend/api/returns_routes.py:798-803`의 현재 코드:

```python
    @router.get("/returns/cost-base/download")
    def returns_cost_base_download(admin: str = Depends(require_admin)):
        path = return_cost_base_path
        if not path.exists():
            raise HTTPException(status_code=404, detail="원가베이스 파일이 없습니다.")
        return FileResponse(path, filename=path.name)
```

다음으로 교체:

```python
    @router.get("/returns/cost-base/download")
    def returns_cost_base_download(admin: str = Depends(require_admin)):
        df = load_cost_base_df()
        if df.empty:
            raise HTTPException(status_code=404, detail="원가베이스 데이터가 없습니다.")
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": content_disposition("원가베이스유.xlsx")},
        )
```

(`io`, `pd`, `Response`는 파일 상단에 이미 import되어 있음. `FileResponse` import는 다른 곳에서 안 쓰이면 남겨둬도 무해하므로 그대로 둔다.)

- [ ] **Step 4: `/returns/cost-base/add-row`에 상품코드 필수 검증 + `return_cost_base_path` 참조 제거**

`backend/api/returns_routes.py:915-949`의 현재 코드:

```python
    @router.post("/returns/cost-base/add-row")
    def returns_cost_base_add_row(payload: dict = Body(...), admin: str = Depends(require_admin)):
        name = str(payload.get("name") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not name and not code:
            raise HTTPException(status_code=400, detail="A열 또는 I열 값을 입력하세요.")

        try:
            df = load_cost_base_df().copy()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")

        row_data: dict[str, object] = {}
        row_data[df.columns[COST_BASE_CODE_COL]] = code
        row_data[df.columns[COST_BASE_MATCH_COL]] = name
        for index, col in enumerate(list(df.columns)):
            if index not in (COST_BASE_CODE_COL, COST_BASE_MATCH_COL):
                row_data[col] = ""

        df = pd.concat([df, pd.DataFrame([row_data], columns=list(df.columns))], ignore_index=True)

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        state = get_return_state(admin)
        state.cost_base_path = return_cost_base_path
        load_return_cost_base(state)
        return {"ok": True, "status": return_status(state), "row_added": {"name": name, "code": code}}
```

다음으로 교체:

```python
    @router.post("/returns/cost-base/add-row")
    def returns_cost_base_add_row(payload: dict = Body(...), admin: str = Depends(require_admin)):
        name = str(payload.get("name") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="A열 상품코드는 필수입니다. (상품코드 없는 행은 추가할 수 없습니다)")

        try:
            df = load_cost_base_df().copy()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")

        row_data: dict[str, object] = {}
        row_data[df.columns[COST_BASE_CODE_COL]] = code
        row_data[df.columns[COST_BASE_MATCH_COL]] = name
        for index, col in enumerate(list(df.columns)):
            if index not in (COST_BASE_CODE_COL, COST_BASE_MATCH_COL):
                row_data[col] = ""

        df = pd.concat([df, pd.DataFrame([row_data], columns=list(df.columns))], ignore_index=True)

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        state = get_return_state(admin)
        load_return_cost_base(state)
        return {"ok": True, "status": return_status(state), "row_added": {"name": name, "code": code}}
```

- [ ] **Step 5: `/returns/cost-base/append-rows`에서도 `return_cost_base_path` 참조 제거**

`backend/api/returns_routes.py:990-993`의 현재 코드:

```python
        state = get_return_state(admin)
        state.cost_base_path = return_cost_base_path
        load_return_cost_base(state)
        return {"ok": True, "appended": len(new_rows)}
```

다음으로 교체:

```python
        state = get_return_state(admin)
        load_return_cost_base(state)
        return {"ok": True, "appended": len(new_rows)}
```

- [ ] **Step 6: 서버 재시작 후 수동 검증**

`backend/` 디렉터리에서 서버 재시작, 관리자 토큰(`$ADMIN_TOKEN`)으로:

```bash
curl -s -X POST http://127.0.0.1:8000/returns/cost-base/reload -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: `{"ok":true,"cost_count":<정수>,"status":{...}}` — `cost_count`가 db관리 `원가베이스유` 행 수와 비슷한 규모로 나옴 (상품명합 중복 제거 후 값이라 행 수보다 작거나 같을 수 있음).

```bash
curl -s "http://127.0.0.1:8000/returns/cost-base/preview?offset=0&limit=5" -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: `rows`에 db관리 WonbeTable과 동일한 상품코드/상품명합.

```bash
curl -s -X POST http://127.0.0.1:8000/returns/cost-base/add-row \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"테스트","code":""}'
```

Expected: HTTP 400, `{"detail":"A열 상품코드는 필수입니다. (상품코드 없는 행은 추가할 수 없습니다)"}`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/returns/cost-base/upload
```

Expected: `404` 또는 `405` (엔드포인트 삭제됨).

db관리 화면에서 방금 확인한 상품코드가 그대로 보이는지 (양쪽 데이터가 진짜 같은 테이블을 보고 있는지) 대조 확인.

- [ ] **Step 7: Commit**

```bash
git add backend/api/returns_routes.py
git commit -m "refactor: 반품 원가베이스 업로드 제거, 다운로드/추가를 wonbe DB 기반으로 전환"
```

---

### Task 6: `returns_utils.py`의 매칭 키 정규화를 casefold로 통일

**Files:**
- Modify: `backend/services/returns_utils.py:77-82`

**Interfaces:**
- Consumes: 없음.
- Produces: `_normalize_key`가 `.lower()` 대신 `.casefold()`를 사용 — Task 1의 `_normalize_cost_base_key`(맵 생성 시 사용)와 정규화 방식을 일치시켜, `/returns/onebe/build`에서 `state.cost_map` 조회 시 키 불일치 가능성을 없앤다.

- [ ] **Step 1: `_normalize_key` 수정**

`backend/services/returns_utils.py:77-82`의 현재 코드:

```python
def _normalize_key(s: str) -> str:
    if s is None:
        return ""
    s = str(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.lower()
```

다음으로 교체:

```python
def _normalize_key(s: str) -> str:
    if s is None:
        return ""
    s = str(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.casefold()
```

- [ ] **Step 2: 확인**

```bash
python -c "from services.returns_utils import _normalize_key; print(_normalize_key('  Test Product   FREE  '))"
```

Expected: `test product free` (기존 `.lower()`와 결과가 동일한 것을 일반적인 한글/영문 데이터에서 확인).

- [ ] **Step 3: Commit**

```bash
git add backend/services/returns_utils.py
git commit -m "fix: 반품 원가베이스 매칭 키 정규화를 casefold로 통일"
```

---

### Task 7: 프런트엔드 — 아무드 합배송 원가베이스 업로드 UI 제거

**Files:**
- Modify: `src/components/Barcode/AmoodHapbaePage.jsx:29` (`costBaseFile` state 제거)
- Modify: `src/components/Barcode/AmoodHapbaePage.jsx:271-297` (`handleCostBaseUpload` 함수 제거)
- Modify: `src/components/Barcode/AmoodHapbaePage.jsx:548-555` (업로드 버튼/파일 입력 JSX 제거)

**Interfaces:**
- Consumes: 없음 (백엔드 `/amood-hapbae/cost-base/upload`가 Task 2에서 삭제됨에 따라 대응하는 프런트 UI 제거).
- Produces: 변경 없음.

**참고:** `src/components/Barcode/ReturnsPage.jsx`는 `/returns/cost-base/upload`를 호출하는 UI가 원래 없었으므로 (grep 확인 완료) 프런트 변경이 필요 없다.

- [ ] **Step 1: `costBaseFile` state 제거**

`src/components/Barcode/AmoodHapbaePage.jsx:29`의 다음 줄을 삭제:

```jsx
  const [costBaseFile, setCostBaseFile] = useState(null);
```

- [ ] **Step 2: `handleCostBaseUpload` 함수 제거**

`src/components/Barcode/AmoodHapbaePage.jsx:271-297`의 다음 함수 전체를 삭제:

```jsx
  const handleCostBaseUpload = async () => {
    if (!costBaseFile) {
      setCostMessage("원가베이스 파일을 선택하세요.");
      return;
    }
    setLoadingCostBase(true);
    setCostMessage("");
    try {
      const formData = new FormData();
      formData.append("file", costBaseFile);
      const res = await fetch(`${API}/amood-hapbae/cost-base/upload`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || "원가베이스 업로드 실패");
      setCostBase(data.status || null);
      setCostMessage("원가베이스 업로드 완료");
      setCostBaseFile(null);
    } catch (err) {
      setCostMessage(err.message || "원가베이스 업로드 실패");
    } finally {
      setLoadingCostBase(false);
    }
  };
```

- [ ] **Step 3: 업로드 버튼/파일 입력 JSX 제거**

`src/components/Barcode/AmoodHapbaePage.jsx:548-555`의 현재 코드:

```jsx
        <div className={styles.uploadRow}>
          <label className={styles.fileInput} style={{ flex: 1, justifyContent: "flex-start" }}>
            <input type="file" accept=".xls,.xlsx,.xlsm" onChange={(e) => setCostBaseFile(e.target.files?.[0] ?? null)} />
            {costBaseFile ? costBaseFile.name : "원가베이스 파일 선택"}
          </label>
          <button type="button" className={styles.primaryBtn} onClick={handleCostBaseUpload} disabled={loadingCostBase}>
            {loadingCostBase ? "업로드 중..." : "업로드"}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={handleCostBaseReload} disabled={loadingCostBase}>
```

다음으로 교체 (업로드 `label`/`button` 2개 제거, "새로 로드" 버튼부터 시작):

```jsx
        <div className={styles.uploadRow}>
          <button type="button" className={styles.secondaryBtn} onClick={handleCostBaseReload} disabled={loadingCostBase}>
```

(이어지는 "다운로드"/"원가베이스 데이터 추가"/"편집" 버튼 3개는 그대로 둔다.)

- [ ] **Step 4: 브라우저 수동 확인**

`npm run dev` 실행 후 사이드메뉴 → 합배송(아무드) 페이지 → "② 원가베이스 관리" 카드에서 업로드 버튼/파일 선택창이 사라지고 "새로 로드"/"다운로드"/"원가베이스 데이터 추가"/"편집" 버튼만 남아있는지 확인. "편집" 클릭 시 db관리 `원가베이스유`와 동일한 데이터가 보이는지, "다운로드" 클릭 시 xlsx 파일이 정상적으로 받아지는지 확인.

- [ ] **Step 5: Commit**

```bash
git add src/components/Barcode/AmoodHapbaePage.jsx
git commit -m "refactor: 합배송 원가베이스 업로드 UI 제거"
```

---

### Task 8: 전체 통합 수동 검증

**Files:** 없음 (검증 전용 태스크)

- [ ] **Step 1: 백엔드 전체 기동 확인**

```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Expected: import 에러 없이 정상 기동 (`ModuleNotFoundError`, `NameError`, `TypeError: build_returns_router() missing/unexpected keyword` 등이 없어야 함 — Task 4/5의 `return_cost_base_path` 제거가 양쪽에서 짝이 맞아야 통과).

- [ ] **Step 2: db관리 ↔ 합배송 ↔ 반품 데이터 일치 확인**

1. 브라우저에서 db관리 → `원가베이스유` 탭에서 임의 상품코드 하나의 `상품명합` 값을 수정하고 저장.
2. 같은 브라우저에서 합배송(아무드) 페이지 → 원가베이스 "편집" 창을 열어 검색 → 방금 수정한 값이 그대로 보이는지 확인.
3. 반품 페이지 → 원가베이스 미리보기(있다면) 또는 `curl`로 `/returns/cost-base/preview?q=<검색어>` 호출 → 동일한 값이 보이는지 확인.

Expected: 세 화면이 모두 같은 데이터를 가리킴 (더 이상 서로 다른 파일을 보지 않음).

- [ ] **Step 3: 합배송 원가베이스 데이터 추가 → db관리에 반영되는지 확인**

합배송(아무드) 페이지에서 "원가베이스 데이터 추가"로 신규 상품코드 1건 추가 → db관리 `원가베이스유` 탭에서 새로고침 후 해당 상품코드가 보이는지 확인.

Expected: 보임 (같은 테이블을 공유하므로).

- [ ] **Step 4: 회귀 확인 — 입고대기/에이블리재고변경/케이디지원가베이스**

db관리 화면에서 `입고대기`, `에이블리재고변경`, `케이디지원가베이스` 탭을 열어 기존 데이터가 그대로 남아있는지 확인 (이번 변경이 `wonbe` 테이블을 삭제하지 않았음을 최종 확인).

Expected: 데이터 유실 없음.

- [ ] **Step 5: 최종 커밋 없음 (이미 각 Task에서 커밋 완료)**

이 Task는 검증 전용이며 별도 커밋이 없다. 문제가 발견되면 해당 Task로 돌아가 수정 후 새 커밋을 추가한다.

---

## Self-Review

**Spec coverage:**
- "아무드 합배송 + 반품 처리 둘 다 db관리 wonbe 테이블로 이관" → Task 2(아무드), Task 4+5(반품)에서 반영.
- "제주 합배송은 코드 변경 없이 그대로 두되 자동으로 최신 DB를 읽게" → Task 3에서 최소한의 존재 체크 수정만 적용 (매칭 로직 자체는 무변경).
- "원가베이스 업로드(전체교체) 기능 완전 제거" → Task 2 Step 3(`/amood-hapbae/cost-base/upload` 삭제), Task 5 Step 2(`/returns/cost-base/upload` 삭제), Task 7(프런트 업로드 UI 제거).
- "파괴적인 DELETE+전체재삽입이 아니라 상품코드 기준 upsert" → Task 1의 `save_wonbe_cost_base_df`가 `INSERT OR REPLACE`만 사용, `DELETE FROM wonbe` 없음.
- "상품코드 빈 값 신규 행 추가 거부" → Task 2 Step 7(아무드 add-row), Task 5 Step 4(반품 add-row). 추가로 `save_wonbe_cost_base_df` 자체도 빈 코드 행을 스킵하도록 이중 방어.
- "URL 경로와 응답 계약 유지" → 업로드 삭제 외 모든 엔드포인트가 동일한 경로/응답 필드 유지 (Task 2, 5에서 각 엔드포인트별로 확인).
- "order_routes.py는 별도 조사 필요" → **범위 밖으로 확정, 알려진 리스크로 명시.** `order_routes.py`도 동일한 `SHARED_COST_BASE_PATH` 엑셀 파일을 읽기 전용으로 참조하는데(`_build_daily_sales_cost_map`, `_load_cost_base_items`), 이번 변경 이후로는 그 엑셀 파일을 갱신하는 주체가 하나도 없어지므로 시간이 지나면 점점 낡은 데이터를 보게 된다. 사용자가 이번 이관 범위를 "아무드 합배송 + 반품"으로 명시적으로 한정했으므로 이번 계획에는 포함하지 않았지만, Task 8 완료 후 사용자에게 이 잔여 리스크를 별도로 알려야 한다 (주문 라우트의 일일매출/등록상품 매칭 기능이 서서히 stale해짐).

**Placeholder scan:** 모든 스텝에 실행 가능한 전체 코드/명령어 포함. "TODO"/"적절히 처리" 같은 자리표시자 없음.

**Type consistency:** `load_wonbe_cost_base_df`/`save_wonbe_cost_base_df`/`load_wonbe_cost_base_map`/`wonbe_cost_base_status` 이름이 Task 1(정의)과 Task 2/4(사용) 전체에서 동일하게 사용됨. `_ah_load_base_cost_map(_path=None)`의 하위 호환 시그니처가 Task 2(정의)와 Task 3(호출부, 인자 없이 호출하도록 정리)에서 일관됨. `build_returns_router`의 `return_cost_base_path` 파라미터 제거가 Task 4(호출부)와 Task 5(정의부)에서 짝이 맞음 — 한쪽만 적용하면 `TypeError`가 나므로 Task 4와 5는 반드시 함께 커밋/배포되어야 함 (계획 순서상 Task 4 다음 Task 5로 명시).
