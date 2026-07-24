# 날짜별장끼정리 TOP비교 Ctrl+F 검색 & 스페이스 확인완료 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DB관리 > 날짜별장끼정리 > TOP비교` 탭의 DB 패널에서 `Ctrl+F`(또는 `Cmd+F`)를 누르면 브라우저 기본 찾기 대신 자체 검색창이 뜨고, 거래처명을 입력하면 일치하는 행이 자동으로 선택(하이라이트)되며, `Space`를 누르면 선택된 거래처의 "확인완료" 상태를 토글할 수 있게 한다.

**Architecture:** `src/components/DBManager/JanggiTable.jsx`의 `JanggiTopComparison` 컴포넌트에 검색 관련 state(`searchOpen`, `searchTerm`, `selectedMatchIndex`)와 `window` `keydown` 리스너를 추가한다. 매칭 리스트는 기존 `sortedDbRows`를 필터링한 파생 값(`useMemo`)으로 계산하고, 선택된 행은 새 CSS 클래스로 강조 표시 + `scrollIntoView`로 자동 스크롤한다. `Space`는 기존 `toggleCheck` 함수를 그대로 재사용해 확인완료 상태를 토글한다.

**Tech Stack:** React 19 (기존 `useState`/`useEffect`/`useMemo`/`useRef` 패턴), CSS Modules (`JanggiTop.module.css`). 이 저장소에는 프론트엔드 자동화 테스트가 없으므로(vitest/jest 미설치) 각 태스크의 검증은 `npm run lint` + `npm run dev` 후 브라우저 수동 확인으로 진행한다.

## Global Constraints

- 대상은 `JanggiTopComparison`의 DB 패널(거래처 목록 테이블)뿐이다. TOP 패널(TOP90 목록)과 `JanggiListView`(목록 탭)는 건드리지 않는다.
- 기존 "확인완료" 버튼과 `toggleCheck(name)` 함수의 동작·시그니처는 그대로 유지한다 (검색을 통한 토글도 동일 함수를 호출).
- 검색 리스너는 `dbLoaded === true`일 때만 등록한다 — DB 조회 전(TOP비교 탭 진입 직후)에는 브라우저 기본 `Ctrl+F`가 그대로 동작해야 한다.
- 매칭 판정은 거래처명의 공백을 제거하고 대소문자를 구분하지 않는 부분 문자열 포함 여부로 한다.
- 커밋마다 정확한 파일만 `git add`하고, `git commit`은 각 태스크 끝에서 1회.

---

### Task 1: Ctrl+F 가로채기 & 검색창 열기/닫기

**Files:**
- Modify: `src/components/DBManager/JanggiTable.jsx` (`JanggiTopComparison` 컴포넌트 내부, state 선언부 및 DB 패널 JSX)
- Modify: `src/components/DBManager/JanggiTop.module.css`

**Interfaces:**
- Produces: state `searchOpen: boolean`, `searchTerm: string`, `selectedMatchIndex: number`, ref `searchInputRef`, ref `selectedRowRef`, 함수 `handleSearchKeyDown(e)`. Task 2/3/4에서 이 이름들을 그대로 사용한다.

- [ ] **Step 1: 검색 관련 state/ref와 Ctrl+F 리스너 추가**

`src/components/DBManager/JanggiTable.jsx`에서 다음 블록을 찾는다:

```jsx
  const [colWidths, setColWidths] = useState({});

  useEffect(() => {
    fetch(`${API}/wonbe/janggi/top-col-widths`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setColWidths(d.widths || {}); })
      .catch(() => {});
  }, []);
```

다음으로 교체한다:

```jsx
  const [colWidths, setColWidths] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMatchIndex, setSelectedMatchIndex] = useState(0);
  const searchInputRef = useRef(null);
  const selectedRowRef = useRef(null);

  useEffect(() => {
    if (!dbLoaded) {
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dbLoaded]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    setSelectedMatchIndex(0);
  }, [searchTerm]);

  useEffect(() => {
    fetch(`${API}/wonbe/janggi/top-col-widths`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setColWidths(d.widths || {}); })
      .catch(() => {});
  }, []);
```

- [ ] **Step 2: `handleSearchKeyDown` 핸들러 추가 (Escape만 처리)**

같은 파일에서 다음 블록을 찾는다:

```jsx
  const resetChecked = () => {
    if (!window.confirm("모든 거래처의 확인완료 표시를 초기화하시겠습니까?")) return;
    setCheckedRows(new Set());
    localStorage.removeItem("janggi_top_checked");
  };

  const loadDb = async () => {
```

다음으로 교체한다:

```jsx
  const resetChecked = () => {
    if (!window.confirm("모든 거래처의 확인완료 표시를 초기화하시겠습니까?")) return;
    setCheckedRows(new Set());
    localStorage.removeItem("janggi_top_checked");
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
    }
  };

  const loadDb = async () => {
```

- [ ] **Step 3: DB 패널에 검색창 JSX 추가**

같은 파일에서 다음 블록을 찾는다:

```jsx
          <div className={topStyles.panel}>
            <div className={topStyles.panelHeader}>
              DB 날짜별장끼정리
              <span className={topStyles.panelDate}>
                {dbDate}
                {dbTotal > 0 && <span style={{ marginLeft: "0.75rem", fontWeight: 700, color: "var(--text-primary)" }}>합계 {Math.round(dbTotal).toLocaleString()}원</span>}
              </span>
            </div>
            <table className={topStyles.table}>
```

다음으로 교체한다:

```jsx
          <div className={topStyles.panel}>
            <div className={topStyles.panelHeader}>
              DB 날짜별장끼정리
              <span className={topStyles.panelDate}>
                {dbDate}
                {dbTotal > 0 && <span style={{ marginLeft: "0.75rem", fontWeight: 700, color: "var(--text-primary)" }}>합계 {Math.round(dbTotal).toLocaleString()}원</span>}
              </span>
            </div>
            {searchOpen && (
              <div className={topStyles.searchBar}>
                <input
                  ref={searchInputRef}
                  className={topStyles.searchInput}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="거래처 검색... (Esc로 닫기)"
                />
                <button
                  className={topStyles.searchClose}
                  onClick={() => { setSearchOpen(false); setSearchTerm(""); }}
                  title="검색 닫기"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <table className={topStyles.table}>
```

- [ ] **Step 4: 검색창 CSS 추가**

`src/components/DBManager/JanggiTop.module.css` 맨 끝에 추가:

```css

.searchBar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
}

.searchInput {
  flex: 1;
  padding: 0.35rem 0.6rem;
  border: 1px solid #fbbf24;
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.82rem;
  outline: none;
}
.searchInput:focus { border-color: #d97706; }

.searchCount {
  font-size: 0.78rem;
  font-weight: 600;
  color: #92400e;
  white-space: nowrap;
}

.searchClose {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #92400e;
  padding: 0.2rem;
}
.searchClose:hover { color: #78350f; }
```

- [ ] **Step 5: lint 검사**

Run: `npm run lint`
Expected: `JanggiTable.jsx`, `JanggiTop.module.css` 관련 에러 없음 (기존에 있던 다른 파일 경고는 무관).

- [ ] **Step 6: 브라우저 수동 확인**

`npm run dev` 실행 후 브라우저에서 DB관리 > 날짜별장끼정리 > TOP비교 탭으로 이동:
1. "조회" 버튼을 눌러 `dbLoaded`를 `true`로 만든다.
2. `Ctrl+F`(Mac은 `Cmd+F`)를 누른다 → 브라우저 기본 찾기 바가 뜨지 않고, DB 패널 헤더 아래에 노란 배경의 검색 입력창이 나타나고 자동으로 포커스된다.
3. `Escape`를 누르거나 X 버튼을 클릭 → 검색창이 사라진다.
4. TOP비교 탭에 진입만 하고 "조회"를 누르지 않은 상태(DB 패널이 없는 상태)에서 `Ctrl+F`를 누르면 브라우저 기본 찾기가 정상 동작하는지 확인.

- [ ] **Step 7: 커밋**

```bash
git add src/components/DBManager/JanggiTable.jsx src/components/DBManager/JanggiTop.module.css
git commit -m "feat: TOP비교 DB패널에 Ctrl+F 자체 검색창 추가"
```

---

### Task 2: 거래처 매칭 & 선택 행 하이라이트 + 자동 스크롤

**Files:**
- Modify: `src/components/DBManager/JanggiTable.jsx`
- Modify: `src/components/DBManager/JanggiTop.module.css`

**Interfaces:**
- Consumes: Task 1의 `searchTerm`, `selectedMatchIndex`, `selectedRowRef`, `searchOpen` JSX 블록.
- Produces: `searchMatches: Array<row>` (검색어와 일치하는 `sortedDbRows` 부분집합), `selectedMatch: row | null` (`searchMatches[selectedMatchIndex]`). Task 3/4에서 그대로 사용한다.

- [ ] **Step 1: `searchMatches`/`selectedMatch` 파생 값과 자동 스크롤 이펙트 추가**

`src/components/DBManager/JanggiTable.jsx`에서 다음 블록을 찾는다:

```jsx
  const sortedDbRows = [...dbRows].sort((a, b) => (a.거래처 || "").localeCompare(b.거래처 || "", "ko"));
  const visibleTopShops = topShops
```

다음으로 교체한다:

```jsx
  const sortedDbRows = [...dbRows].sort((a, b) => (a.거래처 || "").localeCompare(b.거래처 || "", "ko"));

  const normalizeSearchName = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();
  const searchMatches = useMemo(() => {
    const term = normalizeSearchName(searchTerm);
    if (!term) return [];
    return sortedDbRows.filter((r) => normalizeSearchName(r.거래처).includes(term));
  }, [sortedDbRows, searchTerm]);
  const selectedMatch = searchMatches[selectedMatchIndex] || null;

  useEffect(() => {
    if (selectedRowRef.current) selectedRowRef.current.scrollIntoView({ block: "nearest" });
  }, [selectedMatch]);

  const visibleTopShops = topShops
```

- [ ] **Step 2: 매칭 카운터를 검색창 UI에 표시**

같은 파일에서 다음 블록을 찾는다:

```jsx
                <input
                  ref={searchInputRef}
                  className={topStyles.searchInput}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="거래처 검색... (Esc로 닫기)"
                />
                <button
```

다음으로 교체한다:

```jsx
                <input
                  ref={searchInputRef}
                  className={topStyles.searchInput}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="거래처 검색... (Esc로 닫기)"
                />
                <span className={topStyles.searchCount}>
                  {searchMatches.length ? `${selectedMatchIndex + 1}/${searchMatches.length}` : "0/0"}
                </span>
                <button
```

- [ ] **Step 3: DB 패널 행에 선택 하이라이트 적용**

같은 파일에서 다음 블록을 찾는다:

```jsx
                {sortedDbRows.map((r) => {
                  const checked = checkedRows.has(r.거래처);
                  const matched = topLoaded && dbMatchesTop(r.거래처);
                  const accountOk = hasAccount(r.거래처);
                  const isAddingAccount = addingAccountFor === r.거래처;
                  let rowClass = "";
                  if (checked) rowClass = topStyles.rowChecked;
                  else if (topLoaded) rowClass = matched ? topStyles.rowMatch : topStyles.rowDbOnly;
                  return (
                    <React.Fragment key={r.거래처}>
                      <tr className={rowClass}>
```

다음으로 교체한다:

```jsx
                {sortedDbRows.map((r) => {
                  const checked = checkedRows.has(r.거래처);
                  const matched = topLoaded && dbMatchesTop(r.거래처);
                  const accountOk = hasAccount(r.거래처);
                  const isAddingAccount = addingAccountFor === r.거래처;
                  const isSearchSelected = !!selectedMatch && r.거래처 === selectedMatch.거래처;
                  let rowClass = "";
                  if (checked) rowClass = topStyles.rowChecked;
                  else if (topLoaded) rowClass = matched ? topStyles.rowMatch : topStyles.rowDbOnly;
                  return (
                    <React.Fragment key={r.거래처}>
                      <tr
                        ref={isSearchSelected ? selectedRowRef : null}
                        className={`${rowClass}${isSearchSelected ? ` ${topStyles.rowSearchSelected}` : ""}`}
                      >
```

- [ ] **Step 4: 선택 하이라이트 CSS 추가**

`src/components/DBManager/JanggiTop.module.css` 맨 끝에 추가:

```css

.rowSearchSelected td {
  outline: 2px solid #f59e0b;
  outline-offset: -2px;
}
```

- [ ] **Step 5: lint 검사**

Run: `npm run lint`
Expected: 에러 없음.

- [ ] **Step 6: 브라우저 수동 확인**

`npm run dev`로 실행 중인 화면에서 TOP비교 탭 → 조회 → `Ctrl+F` → 실제 거래처명 일부(2~3글자)를 입력:
1. 일치하는 첫 번째 행에 노란 테두리가 표시되고 카운터가 `1/N`으로 표시된다 (N은 실제 일치 건수).
2. 목록이 길어 선택된 행이 화면 밖에 있으면 자동으로 스크롤되어 보인다.
3. 검색어를 지우면 하이라이트가 사라지고 카운터가 `0/0`이 된다.

- [ ] **Step 7: 커밋**

```bash
git add src/components/DBManager/JanggiTable.jsx src/components/DBManager/JanggiTop.module.css
git commit -m "feat: 검색어 일치 거래처 행 자동 선택 및 하이라이트"
```

---

### Task 3: Enter / Shift+Enter로 다음·이전 매칭 이동

**Files:**
- Modify: `src/components/DBManager/JanggiTable.jsx`

**Interfaces:**
- Consumes: Task 2의 `searchMatches`, `selectedMatchIndex`/`setSelectedMatchIndex`.

- [ ] **Step 1: `handleSearchKeyDown`에 Enter/Shift+Enter 분기 추가**

`src/components/DBManager/JanggiTable.jsx`에서 다음 블록을 찾는다:

```jsx
  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
    }
  };
```

다음으로 교체한다:

```jsx
  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!searchMatches.length) return;
      const dir = e.shiftKey ? -1 : 1;
      setSelectedMatchIndex((i) => (i + dir + searchMatches.length) % searchMatches.length);
    }
  };
```

- [ ] **Step 2: lint 검사**

Run: `npm run lint`
Expected: 에러 없음.

- [ ] **Step 3: 브라우저 수동 확인**

TOP비교 탭 → 조회 → `Ctrl+F` → 매칭이 2건 이상 나오는 검색어 입력(예: 흔한 자음 한 글자):
1. `Enter`를 누르면 카운터가 `2/N`으로 바뀌고 하이라이트가 다음 행으로 이동한다.
2. 마지막 매칭에서 `Enter`를 누르면 다시 첫 번째(`1/N`)로 순환한다.
3. `Shift+Enter`를 누르면 반대 방향(이전 매칭)으로 이동한다.

- [ ] **Step 4: 커밋**

```bash
git add src/components/DBManager/JanggiTable.jsx
git commit -m "feat: 검색 매칭 간 Enter/Shift+Enter 이동"
```

---

### Task 4: Space로 선택된 거래처 확인완료 토글

**Files:**
- Modify: `src/components/DBManager/JanggiTable.jsx`

**Interfaces:**
- Consumes: Task 2의 `selectedMatch`, 기존 `toggleCheck(name: string)` 함수(`JanggiTable.jsx` 내 기존 정의, 시그니처 변경 없음).

- [ ] **Step 1: `handleSearchKeyDown`에 Space 분기 추가**

`src/components/DBManager/JanggiTable.jsx`에서 다음 블록을 찾는다:

```jsx
  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!searchMatches.length) return;
      const dir = e.shiftKey ? -1 : 1;
      setSelectedMatchIndex((i) => (i + dir + searchMatches.length) % searchMatches.length);
    }
  };
```

다음으로 교체한다:

```jsx
  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      setSearchTerm("");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!searchMatches.length) return;
      const dir = e.shiftKey ? -1 : 1;
      setSelectedMatchIndex((i) => (i + dir + searchMatches.length) % searchMatches.length);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (selectedMatch) toggleCheck(selectedMatch.거래처);
    }
  };
```

- [ ] **Step 2: lint 검사**

Run: `npm run lint`
Expected: 에러 없음.

- [ ] **Step 3: 브라우저 수동 확인**

TOP비교 탭 → 조회 → `Ctrl+F` → 거래처명 일부 입력해 한 행이 하이라이트된 상태에서:
1. `Space`를 누르면 검색 입력창에 공백이 입력되지 않고, 하이라이트된 행의 "확인완료" 버튼이 "✓ 완료"로 바뀐다(취소선 텍스트 스타일도 적용됨).
2. 같은 행이 선택된 채로 `Space`를 다시 누르면 "확인완료" 상태로 되돌아간다.
3. 새로고침 후에도 확인완료 상태가 유지된다 (localStorage `janggi_top_checked` 기반 — 기존 동작 재사용이므로 별도 구현 불필요, 확인만).
4. 검색창을 닫고 마우스로 "확인완료" 버튼을 클릭해도 기존과 동일하게 동작하는지 확인 (회귀 없음).

- [ ] **Step 4: 커밋**

```bash
git add src/components/DBManager/JanggiTable.jsx
git commit -m "feat: 검색 선택 거래처를 Space로 확인완료 토글"
```
