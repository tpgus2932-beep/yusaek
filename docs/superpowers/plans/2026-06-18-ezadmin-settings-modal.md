# EZAdmin Settings Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 헤더 검색창을 제거하고 그 자리에 EZAdmin 세션(PHPSESSID) 설정 버튼을 추가한다. 버튼 클릭 시 모달이 열려 현재 저장된 PHPSESSID 값을 조회·수정할 수 있다.

**Architecture:** 백엔드 `GET /ezadmin/session` 응답에 실제 `phpsessid` 값을 추가하고, `Header.jsx`에서 이 값을 조회해 모달로 표시·편집한다. 검색창(`searchBar`) 관련 HTML/CSS는 완전히 제거한다.

**Tech Stack:** React (JSX), CSS Modules, Python (FastAPI), SQLite

## Global Constraints

- `LOCAL_API_BASE` 사용 (barcode router는 prefix 없이 `main.py`에 마운트됨)
- 인증 헤더: `getAuthHeaders()` from `../../lib/api`
- CSS 변수 사용: `var(--bg-primary)`, `var(--border-color)`, `var(--radius-sm)` 등 기존 변수 유지
- 새 npm 패키지 추가 금지

---

## File Map

| 파일 | 변경 유형 | 내용 |
|------|-----------|------|
| `yusaek-main/backend/api/barcode_routes.py` | Modify | `GET /ezadmin/session` → `phpsessid` 필드 추가 반환 |
| `yusaek-main/src/components/Layout/Header.jsx` | Modify | 검색창 제거, EZAdmin 설정 버튼 + 모달 추가 |
| `yusaek-main/src/components/Layout/Header.module.css` | Modify | 검색바 스타일 제거, `ezadminBtn` 스타일 추가 |

---

### Task 1: 백엔드 — GET /ezadmin/session에 phpsessid 값 반환 추가

**Files:**
- Modify: `yusaek-main/backend/api/barcode_routes.py:1317-1320`

**Interfaces:**
- Produces: `GET /ezadmin/session` → `{ ok: true, has_session: bool, phpsessid: str }`

- [ ] **Step 1: barcode_routes.py의 ezadmin_session_status 함수 수정**

`yusaek-main/backend/api/barcode_routes.py` 파일에서 아래 기존 코드를:

```python
    @router.get("/ezadmin/session")
    def ezadmin_session_status(user: str = Depends(get_current_user)):
        phpsessid = get_setting(_EZADMIN_SESSION_KEY) or ""
        return {"ok": True, "has_session": bool(phpsessid.strip())}
```

아래로 교체:

```python
    @router.get("/ezadmin/session")
    def ezadmin_session_status(user: str = Depends(get_current_user)):
        phpsessid = get_setting(_EZADMIN_SESSION_KEY) or ""
        return {"ok": True, "has_session": bool(phpsessid.strip()), "phpsessid": phpsessid}
```

- [ ] **Step 2: 수동 확인**

백엔드 서버가 실행 중이라면 `GET /ezadmin/session` 호출 시 응답에 `"phpsessid"` 필드가 포함되는지 확인.
응답 예시: `{"ok": true, "has_session": true, "phpsessid": "v9k4gj69nndm2hchvdmcatbka3"}`

---

### Task 2: CSS — 검색바 스타일 제거 및 EZAdmin 버튼 스타일 추가

**Files:**
- Modify: `yusaek-main/src/components/Layout/Header.module.css`

**Interfaces:**
- Produces: `.ezadminBtn` 클래스 (Header.jsx에서 사용)

- [ ] **Step 1: 검색바 관련 스타일 제거**

`Header.module.css`에서 아래 세 블록을 제거:

```css
.searchBar {
    display: flex;
    align-items: center;
    background-color: var(--bg-tertiary);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
    width: 300px;
}

.searchIcon {
    color: var(--text-muted);
}

.searchBar input {
    background: transparent;
    border: none;
    outline: none;
    margin-left: 0.5rem;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
}
```

그리고 모바일 미디어 쿼리 안의 아래 블록도 제거:

```css
    .searchBar {
        display: none;
    }
```

- [ ] **Step 2: EZAdmin 버튼 스타일 추가**

`.header { ... }` 블록 바로 아래(`.searchBar` 가 있던 자리 이후)에 아래 스타일을 추가:

```css
.ezadminBtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0.5rem 0.9rem;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.15s;
}

.ezadminBtn:hover {
    border-color: var(--text-muted);
}
```

- [ ] **Step 3: 모달 내 값 표시 스타일 추가**

기존 `.modalLabel input` 아래에 아래 스타일 추가:

```css
.sessionValueRow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.sessionValue {
    flex: 1;
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: monospace;
    word-break: break-all;
    min-height: 2.2rem;
}

.sessionValueEmpty {
    color: var(--text-muted);
    font-style: italic;
    font-family: inherit;
}

.toggleVisibilityBtn {
    flex-shrink: 0;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    cursor: pointer;
}

.successMsg {
    color: #059669;
    background: rgba(5, 150, 105, 0.08);
    border: 1px solid rgba(5, 150, 105, 0.2);
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
}
```

---

### Task 3: Header.jsx — 검색창 제거 및 EZAdmin 설정 모달 추가

**Files:**
- Modify: `yusaek-main/src/components/Layout/Header.jsx`

**Interfaces:**
- Consumes: `GET LOCAL_API_BASE/ezadmin/session` → `{ ok, has_session, phpsessid }`
- Consumes: `POST LOCAL_API_BASE/ezadmin/session` body `{ phpsessid }` → `{ ok }`
- Consumes: `.ezadminBtn`, `.sessionValueRow`, `.sessionValue`, `.sessionValueEmpty`, `.toggleVisibilityBtn`, `.successMsg` from Header.module.css (Task 2에서 추가)

- [ ] **Step 1: import 수정 — Search 제거, Key 추가, LOCAL_API_BASE import**

기존:
```jsx
import { Search, Bell } from 'lucide-react';
import { useState } from 'react';
import styles from './Header.module.css';
import { COLLAB_API_BASE } from '../../lib/api';
```

교체:
```jsx
import { Bell, Key } from 'lucide-react';
import { useState } from 'react';
import styles from './Header.module.css';
import { COLLAB_API_BASE, LOCAL_API_BASE, getAuthHeaders } from '../../lib/api';
```

- [ ] **Step 2: EZAdmin 모달 관련 state 추가**

`const [showProfile, setShowProfile] = useState(false);` 바로 아래에 추가:

```jsx
const [showEzadmin, setShowEzadmin] = useState(false);
const [ezadminValue, setEzadminValue] = useState('');
const [ezadminInput, setEzadminInput] = useState('');
const [ezadminVisible, setEzadminVisible] = useState(false);
const [ezadminLoading, setEzadminLoading] = useState(false);
const [ezadminMsg, setEzadminMsg] = useState('');
const [ezadminMsgType, setEzadminMsgType] = useState('');
```

- [ ] **Step 3: EZAdmin 모달 열기 함수 추가**

`saveProfile` 함수 아래에 추가:

```jsx
const openEzadmin = async () => {
    setEzadminMsg('');
    setEzadminMsgType('');
    setEzadminVisible(false);
    setEzadminInput('');
    setShowEzadmin(true);
    try {
        setEzadminLoading(true);
        const res = await fetch(`${LOCAL_API_BASE}/ezadmin/session`, {
            headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
            setEzadminValue(data.phpsessid || '');
            setEzadminInput(data.phpsessid || '');
        }
    } catch {
        // 조회 실패 시 빈 값으로 진행
    } finally {
        setEzadminLoading(false);
    }
};

const saveEzadmin = async () => {
    const phpsessid = ezadminInput.trim();
    if (!phpsessid) {
        setEzadminMsg('PHPSESSID를 입력해주세요.');
        setEzadminMsgType('error');
        return;
    }
    try {
        setEzadminLoading(true);
        setEzadminMsg('');
        const res = await fetch(`${LOCAL_API_BASE}/ezadmin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ phpsessid }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) throw new Error(data?.detail || '저장 실패');
        setEzadminValue(phpsessid);
        setEzadminMsg('저장 완료');
        setEzadminMsgType('ok');
    } catch (err) {
        setEzadminMsg(err.message || '저장 실패');
        setEzadminMsgType('error');
    } finally {
        setEzadminLoading(false);
    }
};
```

- [ ] **Step 4: JSX — 검색창 제거, EZAdmin 버튼으로 교체**

기존:
```jsx
return (
    <header className={styles.header}>
        <div className={styles.searchBar}>
            <Search size={18} className={styles.searchIcon} />
            <input type="text" placeholder="Search anything..." />
        </div>
```

교체:
```jsx
return (
    <header className={styles.header}>
        <button type="button" className={styles.ezadminBtn} onClick={openEzadmin}>
            <Key size={15} />
            EZAdmin 설정
        </button>
```

- [ ] **Step 5: JSX — EZAdmin 모달 추가**

기존 프로필 모달(`{showProfile && ...}`) 블록 바로 아래에 추가:

```jsx
{showEzadmin && (
    <div className={styles.modalOverlay} onClick={() => { setShowEzadmin(false); setEzadminMsg(''); }}>
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
                <h4 className={styles.modalTitle}>EZAdmin 세션 설정</h4>
                <button
                    className={styles.secondaryBtn}
                    onClick={() => { setShowEzadmin(false); setEzadminMsg(''); }}
                >
                    닫기
                </button>
            </div>

            <label className={styles.modalLabel}>
                현재 저장된 PHPSESSID
                <div className={styles.sessionValueRow}>
                    <div className={`${styles.sessionValue} ${!ezadminValue ? styles.sessionValueEmpty : ''}`}>
                        {ezadminLoading
                            ? '불러오는 중...'
                            : ezadminValue
                                ? (ezadminVisible ? ezadminValue : `${ezadminValue.slice(0, 6)}${'•'.repeat(Math.max(0, ezadminValue.length - 6))}`)
                                : '저장된 값 없음'}
                    </div>
                    {ezadminValue && (
                        <button
                            type="button"
                            className={styles.toggleVisibilityBtn}
                            onClick={() => setEzadminVisible((v) => !v)}
                        >
                            {ezadminVisible ? '숨기기' : '보기'}
                        </button>
                    )}
                </div>
            </label>

            <label className={styles.modalLabel}>
                새 값으로 변경
                <input
                    type="text"
                    value={ezadminInput}
                    onChange={(e) => setEzadminInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEzadmin(); }}
                    placeholder="PHPSESSID 값 붙여넣기"
                    disabled={ezadminLoading}
                />
            </label>

            {ezadminMsg && (
                <div className={ezadminMsgType === 'ok' ? styles.successMsg : styles.error}>
                    {ezadminMsg}
                </div>
            )}

            <button
                className={styles.primaryBtn}
                onClick={saveEzadmin}
                disabled={ezadminLoading}
            >
                {ezadminLoading ? '처리 중...' : '저장'}
            </button>
        </div>
    </div>
)}
```

- [ ] **Step 6: 수동 확인**

1. 앱 실행 후 헤더에 `EZAdmin 설정` 버튼이 보이는지 확인
2. 버튼 클릭 시 모달 열림, 현재 저장된 PHPSESSID 값 표시 (마스킹)
3. "보기" 버튼 클릭 시 전체 값 노출
4. 값 수정 후 "저장" 클릭 → "저장 완료" 메시지
5. 모달 재오픈 시 새 값 반영 확인

---

## Self-Review

**Spec coverage:**
- [x] 검색창 제거 → Task 2(CSS), Task 3 Step 4
- [x] EZAdmin 설정 버튼 헤더 왼쪽 → Task 3 Step 4
- [x] 현재 PHPSESSID 값 조회 표시 → Task 1 + Task 3 Step 3
- [x] 값 마스킹 + 보기 토글 → Task 3 Step 5
- [x] 값 수정 저장 → Task 3 Step 3, Step 5
- [x] 성공/에러 메시지 → Task 2 Step 3, Task 3 Step 5

**Placeholder scan:** 없음

**Type consistency:** `ezadminLoading`, `ezadminValue`, `ezadminInput`, `ezadminVisible`, `ezadminMsg`, `ezadminMsgType` — 모두 Task 3에서 정의·사용 일치
