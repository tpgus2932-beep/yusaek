# 미송 목록 vs EZAdmin 입고대기 체크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 노예김승일 > 미송관리 탭에 "입고대기 체크" 버튼을 추가해서, 로컬 미송 목록(상품코드별 합산 수량)과 EZAdmin(I100 재고 목록)에 실제로 반영된 입고대기수량(`stock_in_standby`)을 비교하고 불일치를 모달로 보여준다.

**Architecture:** 백엔드에 새 엔드포인트 `POST /noye-kimsungil/misong/waiting-base/check-ezadmin`를 추가한다. 기존 `export-to-ezadmin`이 쓰는 미송 상품코드별 합산 쿼리를 공용 헬퍼로 뽑아 재사용하고, EZAdmin `template=I100&action=search`를 오늘 날짜로 호출해 상품코드별 입고대기수량 맵을 만든 뒤 두 맵을 비교한다. 프런트엔드는 기존 `handleIngodaegiEzadmin` / `misongDisappearedOpen` 모달과 동일한 패턴으로 버튼 + 결과 모달을 추가한다.

**Tech Stack:** FastAPI + sqlite3 (backend/api/misong_routes.py), httpx(AsyncClient) for EZAdmin proxy, React + CSS Modules (src/components/NoyeKim/NoyeKimPage.jsx / .module.css). 이 저장소에는 자동화된 테스트 스위트가 없으므로(CLAUDE.md 명시), 각 태스크는 수동 검증(curl / 브라우저 조작)으로 마무리한다.

## Global Constraints

- 신규 엔드포인트는 기존 `misong_routes.py` 라우터(`build_misong_router`) 안에 추가한다. 새 파일을 만들지 않는다.
- EZAdmin 호출은 기존 `_EZADMIN_BASE`, `_EZADMIN_SESSION_KEY`, `httpx.AsyncClient(timeout=600.0, verify=False, follow_redirects=True)` 패턴을 그대로 따른다.
- EZAdmin 세션이 없을 때는 기존 패턴과 동일하게 `{"ok": false, "need_session": true}`를 반환한다.
- `stock_in_standby` 값이 0인 EZAdmin 항목은 비교 대상 맵에서 제외한다 (전체 재고 목록에 0값 상품이 매우 많아 "미송없음" 오탐이 폭증하는 것을 막기 위함).
- 프런트엔드는 기존 CSS 클래스(`styles.modalOverlay`, `styles.modal`/`wideModal`, `styles.misongAlertList`/`misongAlertItem`/`misongAlertCode`, `styles.misongBadgeNegative`/`misongBadgeMissing`/`misongBadgeNotFound`)를 재사용하고 새 CSS는 추가하지 않는다.

---

### Task 1: 백엔드 — 미송 상품코드 합산 헬퍼 추출 + EZAdmin 비교 엔드포인트 추가

**Files:**
- Modify: `backend/api/misong_routes.py:1-19` (import 추가)
- Modify: `backend/api/misong_routes.py:1152-1258` (`waiting_base_export_to_ezadmin` 리팩터링 + 신규 엔드포인트 추가)

**Interfaces:**
- Consumes: 기존 `_normalize_code(value) -> str` (`misong_routes.py:139`), `get_db()`, `get_setting(key)`, `_EZADMIN_BASE`, `_EZADMIN_SESSION_KEY`
- Produces: `_misong_qty_by_code() -> dict[str, int]` (다음 태스크는 없지만 프런트가 소비하는 최종 JSON 응답 형태를 정의함):
  ```json
  {
    "ok": true,
    "checked_at": "2026-07-07T03:34:56.000000+00:00",
    "misong_code_count": 12,
    "ezadmin_code_count": 8,
    "mismatches": [
      {"code": "S14764", "misongQty": 60, "ezadminQty": 65, "reason": "qty_mismatch"},
      {"code": "S99999", "misongQty": 10, "ezadminQty": null, "reason": "code_not_found_in_ezadmin"},
      {"code": "S24589", "misongQty": null, "ezadminQty": 12, "reason": "not_in_misong"}
    ]
  }
  ```
  실패 시: `{"ok": false, "error": "..."}` 또는 `{"ok": false, "need_session": true}`

- [ ] **Step 1: `re` 모듈 import 및 정규식 상수 추가**

`backend/api/misong_routes.py` 최상단 import 블록을 다음과 같이 수정한다 (기존 1~15행):

```python
from urllib.parse import quote
import io
import re
import warnings

import httpx
import xlwt
from fastapi import APIRouter, Depends, HTTPException, Body
from fastapi.responses import Response
from datetime import datetime, timezone
from api.wonbe_routes import _get_wonbe_db, _init_ingodaegi_table

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_STOCK_IN_STANDBY_RE = re.compile(r"org_value='([^']*)'")
```

(`import re`와 `_STOCK_IN_STANDBY_RE` 두 줄만 새로 추가되는 것이며 나머지는 기존 코드 그대로다.)

- [ ] **Step 2: 미송 상품코드별 합산 헬퍼 함수 추가**

`build_misong_router` 함수 내부, `_normalize_code` 정의(`misong_routes.py:139-142`) 바로 아래에 다음 헬퍼를 추가한다:

```python
    def _misong_qty_by_code() -> dict:
        conn = get_db()
        try:
            _init(conn)
            rows = conn.execute(
                "SELECT original_f, SUM(F) AS qty FROM misong_items "
                "WHERE TRIM(original_f) != '' GROUP BY original_f"
            ).fetchall()
            return {
                _normalize_code(r["original_f"]): int(r["qty"] or 0)
                for r in rows
                if _normalize_code(r["original_f"])
            }
        finally:
            conn.close()
```

- [ ] **Step 3: 기존 `waiting_base_export_to_ezadmin`이 새 헬퍼를 재사용하도록 수정**

`misong_routes.py:1162-1178`의 다음 블록:

```python
        conn = get_db()
        try:
            _init(conn)
            rows = conn.execute(
                "SELECT original_f, SUM(F) AS qty FROM misong_items "
                "WHERE TRIM(original_f) != '' GROUP BY original_f"
            ).fetchall()
            qty_by_code = {
                _normalize_code(r["original_f"]): int(r["qty"] or 0)
                for r in rows
                if _normalize_code(r["original_f"])
            }
        finally:
            conn.close()

        if not qty_by_code:
            return {"ok": False, "error": "미송목록이 비어 있습니다."}
```

를 다음으로 교체한다:

```python
        qty_by_code = _misong_qty_by_code()

        if not qty_by_code:
            return {"ok": False, "error": "미송목록이 비어 있습니다."}
```

- [ ] **Step 4: 수동 검증 — 리팩터링이 기존 동작을 깨지 않는지 확인**

Run:
```bash
cd backend
python -c "import api.misong_routes"
```
Expected: 에러 없이 종료 (import 성공, 문법/참조 오류 없음).

- [ ] **Step 5: 신규 엔드포인트 추가**

`misong_routes.py`에서 `waiting_base_export_to_ezadmin` 함수가 끝나고 `return router`(파일 끝, 현재 1258행 부근)가 나오기 **직전**에 다음 엔드포인트를 추가한다:

```python
    # ── 입고대기 체크 (EZAdmin I100 재고 목록 대조) ─────────────────────────────
    @router.post("/waiting-base/check-ezadmin")
    async def waiting_base_check_ezadmin(
        payload: dict = Body(default={}),
        user: str = Depends(get_current_user),
    ):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        misong_qty_by_code = _misong_qty_by_code()
        if not misong_qty_by_code:
            return {"ok": False, "error": "미송목록이 비어 있습니다."}

        today = datetime.now().strftime("%Y-%m-%d")
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1&query_type=name&query_str=&stock_type=2"
            "&stock_start=1&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
            "&date_period_sel=0&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=0&products_sort=1&category=0"
            "&except_soldout=0&temp_soldout=0&location=0"
        )

        cookies = {"PHPSESSID": phpsessid}
        ez_headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://ga80.ezadmin.co.kr/template40.htm?template=I100",
            "X-Requested-With": "XMLHttpRequest",
        }
        base_url = f"{_EZADMIN_BASE}/function.htm"

        ezadmin_qty_by_code: dict[str, int] = {}
        try:
            async with httpx.AsyncClient(timeout=600.0, verify=False, follow_redirects=True) as client:
                page = 1
                while True:
                    ts_ms = str(int(datetime.now().timestamp() * 1000))
                    resp = await client.post(
                        base_url,
                        data={
                            "_search": "false", "nd": ts_ms, "rows": "5000", "page": str(page),
                            "sidx": "", "sord": "asc", "template": "I100", "action": "search",
                            "page_code": "I100", "par": par,
                        },
                        cookies=cookies, headers=ez_headers,
                    )
                    if resp.status_code >= 400:
                        return {"ok": False, "error": f"EZAdmin 조회 실패 (HTTP {resp.status_code})"}
                    try:
                        data = resp.json()
                    except Exception:
                        return {"ok": False, "need_session": True}

                    for row in data.get("rows") or []:
                        cell = row.get("cell") or {}
                        code = _normalize_code(cell.get("key"))
                        if not code:
                            continue
                        match = _STOCK_IN_STANDBY_RE.search(str(cell.get("stock_in_standby") or ""))
                        qty = int(match.group(1)) if match and match.group(1).strip().isdigit() else 0
                        if qty > 0:
                            ezadmin_qty_by_code[code] = qty

                    total_pages = int(data.get("total") or 1)
                    if page >= total_pages or page >= 20:
                        break
                    page += 1
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

        all_codes = sorted(set(misong_qty_by_code) | set(ezadmin_qty_by_code))
        mismatches = []
        for code in all_codes:
            misong_qty = misong_qty_by_code.get(code)
            ez_qty = ezadmin_qty_by_code.get(code)
            if misong_qty is not None and ez_qty is not None:
                if misong_qty != ez_qty:
                    mismatches.append({
                        "code": code, "misongQty": misong_qty, "ezadminQty": ez_qty,
                        "reason": "qty_mismatch",
                    })
            elif misong_qty is not None:
                mismatches.append({
                    "code": code, "misongQty": misong_qty, "ezadminQty": None,
                    "reason": "code_not_found_in_ezadmin",
                })
            else:
                mismatches.append({
                    "code": code, "misongQty": None, "ezadminQty": ez_qty,
                    "reason": "not_in_misong",
                })

        return {
            "ok": True,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "misong_code_count": len(misong_qty_by_code),
            "ezadmin_code_count": len(ezadmin_qty_by_code),
            "mismatches": mismatches,
        }
```

- [ ] **Step 6: 수동 검증 — 정규식 추출 로직 단독 테스트**

Run:
```bash
cd backend
python -c "
import re
r = re.compile(r\"org_value='([^']*)'\")
sample = \"<input type=text class=input22num org_value='65' value='65' style=... >\"
m = r.search(sample)
print(m.group(1))
"
```
Expected output: `65`

- [ ] **Step 7: 수동 검증 — 서버 기동 및 엔드포인트 존재 확인**

Run:
```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000 &
sleep 2
curl -s http://127.0.0.1:8000/openapi.json | python -c "import json,sys; d=json.load(sys.stdin); print('/noye-kimsungil/misong/waiting-base/check-ezadmin' in d['paths'])"
```
Expected output: `True`

(테스트 후 백그라운드 uvicorn 프로세스를 종료한다.)

- [ ] **Step 8: Commit**

```bash
git add backend/api/misong_routes.py
git commit -m "$(cat <<'EOF'
feat: add EZAdmin 입고대기 체크 endpoint for misong list verification

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 프런트엔드 — 상태, 핸들러, "입고대기 체크" 버튼 추가

**Files:**
- Modify: `src/components/NoyeKim/NoyeKimPage.jsx:414-443` (상태 선언부)
- Modify: `src/components/NoyeKim/NoyeKimPage.jsx:1913-1932` (`handleIngodaegiEzadmin` 근처에 신규 핸들러 추가)
- Modify: `src/components/NoyeKim/NoyeKimPage.jsx:2305-2311` (버튼 툴바)

**Interfaces:**
- Consumes: Task 1의 `POST /noye-kimsungil/misong/waiting-base/check-ezadmin` 응답 형태 (위 JSON 스키마), 기존 `openEzadminModal(handler)` (`useEzadminSession` 훅), 기존 `API`, `getAuthHeaders()`
- Produces: `misongCheckOpen` (bool state), `misongCheckLoading` (bool state), `misongCheckResult` (object|null state), `handleMisongCheckEzadmin` (함수) — Task 3에서 모달 렌더링에 사용

- [ ] **Step 1: 상태 선언 추가**

`NoyeKimPage.jsx:441-442`(`ingodaegiLoading`, `ingodaegiMsg` 선언) 바로 아래에 추가:

```jsx
  const [ingodaegiLoading, setIngodaegiLoading] = useState(false);
  const [ingodaegiMsg, setIngodaegiMsg] = useState("");
  const [misongCheckLoading, setMisongCheckLoading] = useState(false);
  const [misongCheckOpen, setMisongCheckOpen] = useState(false);
  const [misongCheckResult, setMisongCheckResult] = useState(null);
```

(기존 두 줄은 그대로 두고 세 줄만 새로 추가한다.)

- [ ] **Step 2: 핸들러 함수 추가**

`handleIngodaegiEzadmin` 함수(`NoyeKimPage.jsx:1913-1932`) 바로 뒤에 추가:

```jsx
  const handleMisongCheckEzadmin = async () => {
    try {
      setMisongCheckLoading(true);
      const res = await fetch(`${API}/noye-kimsungil/misong/waiting-base/check-ezadmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.need_session) {
        openEzadminModal(handleMisongCheckEzadmin);
        return;
      }
      if (!data?.ok) {
        setMessage(data?.error || "입고대기 체크 실패");
        return;
      }
      setMisongCheckResult(data);
      setMisongCheckOpen(true);
    } catch (err) {
      setMessage(err.message || "입고대기 체크 실패");
    } finally {
      setMisongCheckLoading(false);
    }
  };
```

- [ ] **Step 3: 버튼 추가**

`NoyeKimPage.jsx:2305-2311`의 기존 버튼:

```jsx
                <button
                  className={styles.secondaryBtn}
                  onClick={handleIngodaegiEzadmin}
                  disabled={ingodaegiLoading || misongItems.length === 0}
                >
                  {ingodaegiLoading ? "처리 중..." : "입고대기설정"}
                </button>
```

바로 다음 줄에 추가:

```jsx
                <button
                  className={styles.secondaryBtn}
                  onClick={handleMisongCheckEzadmin}
                  disabled={misongCheckLoading || misongItems.length === 0}
                >
                  <Search size={13} />{misongCheckLoading ? "확인 중..." : "입고대기 체크"}
                </button>
```

- [ ] **Step 4: 수동 검증 — 프런트 빌드/린트 확인**

Run:
```bash
npm run lint
```
Expected: 에러 없음 (경고는 기존 코드베이스 관례에 따라 허용).

- [ ] **Step 5: Commit**

```bash
git add src/components/NoyeKim/NoyeKimPage.jsx
git commit -m "$(cat <<'EOF'
feat: add 입고대기 체크 button and handler to 미송관리 tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 프런트엔드 — 결과 모달 추가 및 엔드투엔드 수동 검증

**Files:**
- Modify: `src/components/NoyeKim/NoyeKimPage.jsx:2715-2717` (모달 JSX 삽입)

**Interfaces:**
- Consumes: Task 2의 `misongCheckOpen`, `misongCheckResult`, `setMisongCheckOpen`, `handleMisongCheckEzadmin`, `misongCheckLoading` 상태/함수. 기존 `styles.modalOverlay`, `styles.modal`, `styles.wideModal`, `styles.modalHeader`, `styles.modalTitle`, `styles.modalActions`, `styles.secondaryBtn`, `styles.misongLogBody`, `styles.empty`, `styles.misongAlertList`, `styles.misongAlertItem`, `styles.misongAlertCode`, `styles.misongAlertDetail`.

- [ ] **Step 1: 배지 라벨/클래스 매핑 함수 추가**

`MISONG_ALERT_LABELS`와 `getMisongAlertBadgeClass` 정의부(`NoyeKimPage.jsx:86-101`) 바로 아래에 추가:

```jsx
const MISONG_CHECK_REASON_LABELS = {
  qty_mismatch: "수량불일치",
  code_not_found_in_ezadmin: "코드매칭안됨",
  not_in_misong: "미송없음",
};

function getMisongCheckReasonLabel(reason) {
  return MISONG_CHECK_REASON_LABELS[reason] || "알림";
}

function getMisongCheckBadgeClass(reason, styles) {
  if (reason === "qty_mismatch") return styles.misongBadgeNegative;
  if (reason === "code_not_found_in_ezadmin") return styles.misongBadgeMissing;
  return styles.misongBadgeNotFound;
}
```

- [ ] **Step 2: 모달 JSX 추가**

`NoyeKimPage.jsx:2715`(`misongDisappearedOpen` 모달이 끝나는 `)}` 줄) 바로 다음, `waitingBaseAppendOpen` 모달(2717행)이 시작되기 전에 추가:

```jsx
          {misongCheckOpen && misongCheckResult && (
            <div className={styles.modalOverlay} onClick={() => setMisongCheckOpen(false)}>
              <div className={`${styles.modal} ${styles.wideModal}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>입고대기 체크 결과</span>
                  <div className={styles.modalActions}>
                    <button className={styles.secondaryBtn} onClick={handleMisongCheckEzadmin} disabled={misongCheckLoading}>
                      <RefreshCw size={13} />다시 확인
                    </button>
                    <button className={styles.secondaryBtn} onClick={() => setMisongCheckOpen(false)}>
                      <X size={13} />닫기
                    </button>
                  </div>
                </div>
                <div className={styles.misongLogBody}>
                  <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                    미송 {misongCheckResult.misong_code_count}건 / EZAdmin 입고대기 {misongCheckResult.ezadmin_code_count}건 확인
                  </div>
                  {misongCheckResult.mismatches.length === 0 ? (
                    <div className={styles.empty}>✅ 전체 일치</div>
                  ) : (
                    <>
                      <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.5rem" }}>
                        ⚠️ 불일치 {misongCheckResult.mismatches.length}건
                      </div>
                      <ul className={styles.misongAlertList}>
                        {misongCheckResult.mismatches.map((m) => (
                          <li key={m.code} className={styles.misongAlertItem}>
                            <span className={getMisongCheckBadgeClass(m.reason, styles)}>
                              {getMisongCheckReasonLabel(m.reason)}
                            </span>
                            <span className={styles.misongAlertCode}>{m.code}</span>
                            <span className={styles.misongAlertDetail}>
                              미송 {m.misongQty ?? "-"} / EZAdmin {m.ezadminQty ?? "-"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 3: 수동 검증 — 프런트 빌드/린트 확인**

Run:
```bash
npm run lint
npm run build
```
Expected: 두 명령 모두 에러 없이 종료.

- [ ] **Step 4: 엔드투엔드 수동 검증**

1. 백엔드 실행: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000`
2. 프런트 실행: `npm run dev` 후 브라우저에서 로그인
3. 노예김승일 > 미송관리 탭 이동, 미송 목록에 항목이 1개 이상 있는지 확인 (없으면 "항목 추가"로 임시 항목 추가)
4. "입고대기 체크" 버튼 클릭
   - EZAdmin 세션이 없으면 기존 세션 입력 모달이 뜨는지 확인 (PHPSESSID 입력 후 재시도됨)
   - 세션이 있으면 결과 모달이 뜨는지 확인
5. 미송 목록의 한 상품코드를 EZAdmin에서 의도적으로 다른 입고대기수량으로 바꾼 뒤(또는 미송에만 있고 EZAdmin에는 없는 코드로) 다시 "입고대기 체크"를 눌러 해당 항목이 `qty_mismatch` 또는 `code_not_found_in_ezadmin` 배지로 정확히 표시되는지 확인

Expected: 모달이 정상적으로 열리고, 일치 시 "✅ 전체 일치", 불일치 시 배지+상품코드+수량 비교가 표에 정확히 표시됨.

- [ ] **Step 5: Commit**

```bash
git add src/components/NoyeKim/NoyeKimPage.jsx
git commit -m "$(cat <<'EOF'
feat: add 입고대기 체크 result modal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
