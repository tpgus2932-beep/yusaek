# 일반사유로변경 모달에 "문자 보내지 않기" 옵션 통합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 반품 판매자대기 탭의 "일반사유로변경" 버튼과 "일반사유로변경 (문자없이)" 버튼을 하나로 합치고, 문자 발송 여부를 기존 템플릿 선택 모달 안의 체크박스로 옮긴다.

**Architecture:** 프론트엔드 단일 파일(`src/components/Barcode/ReturnsPage.jsx`) 변경. 새 상태 `reasonChangeSkipSms`를 추가하고, 기존 `handleConfirmReasonChangeWithSms`를 확장해 스킵 여부에 따라 분기하는 단일 확인 핸들러로 만든다. `handleReasonChangeWithoutSms`와 "문자없이" 버튼은 제거한다.

**Tech Stack:** React (기존 `useState`, JSX), 기존 REST 엔드포인트(`/returns/ably-change-reason-submit`, `/sms/templates`, `/return-automation/reply-sms`) 그대로 재사용 — 백엔드 변경 없음.

## Global Constraints

- 새 백엔드 엔드포인트/변경 없음 — 기존 3개 엔드포인트만 재사용 (스펙 "비범위").
- 판매자대기 탭의 다른 버튼(에이블리 환불 요청, 이지어드민 입고처리 등)에는 영향 없음.
- 로그 액션 키는 `reason_change_sms` / `reason_change_no_sms` 그대로 유지.
- 이 프로젝트 프론트엔드에는 자동화 테스트가 없음(레포 컨벤션) — 검증은 `npm run lint` + 개발 서버 수동 확인으로 한다.

참고 스펙: `docs/superpowers/specs/2026-07-29-returns-reason-change-skip-sms-toggle-design.md`

---

### Task 1: 문자 발송 여부 토글을 모달에 통합하고 버튼 하나로 정리

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx:496` (상태 선언부, `reasonChangeConfirmLoading` 바로 다음 줄)
- Modify: `src/components/Barcode/ReturnsPage.jsx:499-521` (`openReasonChangeTemplateModal`, `closeReasonChangeTemplateModal`)
- Modify: `src/components/Barcode/ReturnsPage.jsx:523-622` (`handleConfirmReasonChangeWithSms`, `handleReasonChangeWithoutSms` → 하나의 `handleConfirmReasonChange`로 통합, 후자는 삭제)
- Modify: `src/components/Barcode/ReturnsPage.jsx:1963-1978` (판매자대기 버튼 행: "문자없이" 버튼 삭제)
- Modify: `src/components/Barcode/ReturnsPage.jsx:2891-2898` 인근 모달 본문 (체크박스 추가, 드롭다운/미리보기 비활성화 조건, "진행" 버튼 핸들러/disabled 조건 교체)

**Interfaces:**
- Consumes: 기존 상태 `reasonChangeModalOpen`, `reasonChangeTemplates`, `reasonChangeTemplatesLoading`, `reasonChangeSelectedTemplateId`, `reasonChangePendingItems`, `reasonChangeConfirmLoading`, `reasonChangeLoading`, `reasonChangeResults` — 이름/타입 변경 없음. 기존 헬퍼 `logProcessingActions(scope, actionKey, actionLabel, logEntries)`, `buildLogEntry(src, statusText)`, `normalizeQueues(queues)`, `getAuthHeaders()`, `API` 상수 그대로 사용.
- Produces: 새 상태 `reasonChangeSkipSms` (boolean). 새 핸들러 `handleConfirmReasonChange()` (인자 없음, `reasonChangePendingItems`/`reasonChangeSkipSms`를 클로저로 읽음) — 이후 다른 태스크가 없으므로 외부 소비자는 없음(모달의 "진행" 버튼 `onClick`에서만 참조).

- [ ] **Step 1: 상태 추가**

`src/components/Barcode/ReturnsPage.jsx:496` 다음 줄(`reasonChangeConfirmLoading` 선언 바로 아래)에 추가:

```javascript
    const [reasonChangeSkipSms, setReasonChangeSkipSms] = useState(false);
```

- [ ] **Step 2: 모달 열기/닫기에서 초기화**

`openReasonChangeTemplateModal` 안, 기존 `setReasonChangeSelectedTemplateId('');` 줄(500번째 줄 부근) 바로 아래에 추가:

```javascript
        setReasonChangeSkipSms(false);
```

`closeReasonChangeTemplateModal` 안, 기존 `setReasonChangeSelectedTemplateId('');` 줄(520번째 줄 부근) 바로 아래에 추가:

```javascript
        setReasonChangeSkipSms(false);
```

- [ ] **Step 3: `handleConfirmReasonChangeWithSms`를 `handleConfirmReasonChange`로 교체**

`src/components/Barcode/ReturnsPage.jsx:523-591`의 `handleConfirmReasonChangeWithSms` 전체를 아래 코드로 교체한다 (함수명 변경 + 앞부분에 스킵 분기 추가, 기존 SMS 발송 로직은 그대로 보존):

```javascript
    const handleConfirmReasonChange = async () => {
        const items = reasonChangePendingItems;
        if (reasonChangeSkipSms) {
            setReasonChangeConfirmLoading(true);
            setMessage('');
            try {
                setReasonChangeLoading(true);
                setReasonChangeResults(null);
                const res = await fetch(`${API}/returns/ably-change-reason-submit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ items }),
                });
                const data = await res.json().catch(() => ({}));
                if (data?.queues) setQueues(normalizeQueues(data.queues));
                if (!res.ok) throw new Error(data?.detail || '사유변경 처리 실패');
                setReasonChangeResults(data.results);
                const logEntries = data.results.map((r) => {
                    const src = items.find((i) => i.id === r.id) || {};
                    return buildLogEntry(src, r.ok ? '완료' : `실패: ${r.error || ''}`);
                });
                logProcessingActions('seller', 'reason_change_no_sms', '일반사유변경(문자없이)', logEntries);
                const reasonOk = data.results.filter((r) => r.ok).length;
                setMessage(`일반사유 변경 완료(문자 미발송): ${reasonOk}/${data.results.length}건 성공`);
                closeReasonChangeTemplateModal();
            } catch (err) {
                setMessage(err.message || '일반사유 변경 실패');
            } finally {
                setReasonChangeLoading(false);
                setReasonChangeConfirmLoading(false);
            }
            return;
        }

        const template = reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId);
        if (!template) {
            setMessage('템플릿을 선택하세요.');
            return;
        }
        setReasonChangeConfirmLoading(true);
        setMessage('');
        try {
            setReasonChangeLoading(true);
            setReasonChangeResults(null);
            const res = await fetch(`${API}/returns/ably-change-reason-submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ items }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.queues) setQueues(normalizeQueues(data.queues));
            if (!res.ok) throw new Error(data?.detail || '사유변경 처리 실패');
            setReasonChangeResults(data.results);
            const logEntries = data.results.map((r) => {
                const src = items.find((i) => i.id === r.id) || {};
                return buildLogEntry(src, r.ok ? '완료' : `실패: ${r.error || ''}`);
            });
            logProcessingActions('seller', 'reason_change_sms', '일반사유변경(문자)', logEntries);
            const reasonOk = data.results.filter((r) => r.ok).length;

            let smsOk = 0;
            let smsSkipped = 0;
            let sessionExpired = false;
            for (const item of items) {
                const phone = (item.buyer_tel || '').trim();
                if (!phone) {
                    smsSkipped += 1;
                    continue;
                }
                try {
                    const smsRes = await fetch(`${API}/return-automation/reply-sms`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                        body: JSON.stringify({ phone, msg: template.msg }),
                    });
                    const smsData = await smsRes.json().catch(() => ({}));
                    if (smsData?.need_ezdesk_session) {
                        sessionExpired = true;
                        break;
                    }
                    if (smsRes.ok && smsData?.ok !== false) {
                        smsOk += 1;
                    }
                } catch {
                    // 개별 전송 실패는 무시하고 다음 건으로 진행 (실패 건수는 smsOk와의 차이로 드러남)
                }
            }

            const smsAttempted = items.length - smsSkipped;
            let summary = `일반사유 변경 완료: ${reasonOk}/${data.results.length}건 성공. 문자 전송: ${smsOk}/${smsAttempted}건 성공`;
            if (smsSkipped) summary += ` (전화번호 없음 ${smsSkipped}건 제외)`;
            if (sessionExpired) summary += ' — 이지데스크 세션이 만료되어 이후 발송은 중단했습니다. 테스트 > 자동화 대시보드에서 세션을 재설정해주세요.';
            setMessage(summary);
            closeReasonChangeTemplateModal();
        } catch (err) {
            setMessage(err.message || '일반사유 변경 실패');
        } finally {
            setReasonChangeLoading(false);
            setReasonChangeConfirmLoading(false);
        }
    };
```

이어서 바로 아래에 있던 `handleReasonChangeWithoutSms` 함수 전체(원래 593-622번째 줄, `const handleReasonChangeWithoutSms = async (selectedItems) => { ... };`)를 삭제한다.

- [ ] **Step 4: 판매자대기 버튼 행에서 "문자없이" 버튼 삭제**

`src/components/Barcode/ReturnsPage.jsx:1971-1978`의 아래 블록을 통째로 삭제한다:

```javascript
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleReasonChangeWithoutSms(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (문자없이, ${selectedSeller.size}건)`}
                                    </button>
```

(바로 위 "일반사유로변경" 버튼과 바로 아래 "이지어드민 입고처리" 버튼은 그대로 둔다.)

- [ ] **Step 5: 모달에 체크박스 추가 + 드롭다운 비활성화 + 진행 버튼 교체**

`src/components/Barcode/ReturnsPage.jsx:2870-2898`의 모달 본문 블록 전체를 아래로 교체한다:

```javascript
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9rem' }}>
                                <input
                                    type="checkbox"
                                    checked={reasonChangeSkipSms}
                                    onChange={(e) => setReasonChangeSkipSms(e.target.checked)}
                                />
                                문자 보내지 않기
                            </label>
                            {reasonChangeTemplatesLoading ? (
                                <div>템플릿 불러오는 중...</div>
                            ) : reasonChangeTemplates.length === 0 ? (
                                <div>등록된 템플릿이 없습니다. 사이드메뉴 "문자 발송"에서 템플릿을 먼저 만들어주세요.</div>
                            ) : (
                                <>
                                    <select
                                        value={reasonChangeSelectedTemplateId}
                                        onChange={(e) => setReasonChangeSelectedTemplateId(e.target.value)}
                                        disabled={reasonChangeSkipSms}
                                        style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, opacity: reasonChangeSkipSms ? 0.5 : 1 }}
                                    >
                                        {reasonChangeTemplates.map((t) => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </select>
                                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, padding: 10, minHeight: 60, opacity: reasonChangeSkipSms ? 0.5 : 1 }}>
                                        {reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId)?.msg || ''}
                                    </div>
                                </>
                            )}
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleConfirmReasonChange}
                                disabled={
                                    reasonChangeConfirmLoading ||
                                    (!reasonChangeSkipSms && (reasonChangeTemplatesLoading || !reasonChangeSelectedTemplateId))
                                }
                            >
                                {reasonChangeConfirmLoading ? '처리 중...' : '진행'}
                            </button>
                        </div>
```

- [ ] **Step 6: 사용하지 않는 참조 확인**

`ReturnsPage.jsx` 전체에서 `handleReasonChangeWithoutSms`를 검색해 남은 참조가 없는지 확인한다 (버튼과 함수 정의 둘 다 삭제했으므로 0건이어야 함).

Run: 리포지토리 루트에서 `grep -n "handleReasonChangeWithoutSms" "src/components/Barcode/ReturnsPage.jsx"` (Windows Git Bash 기준)
Expected: 출력 없음(매치 0건)

- [ ] **Step 7: Lint 실행**

Run: `npm run lint`
Expected: `src/components/Barcode/ReturnsPage.jsx` 관련 에러 없이 통과 (레포에 이미 존재하던 다른 파일의 기존 경고/에러는 무관)

- [ ] **Step 8: 개발 서버로 수동 확인**

Run: `npm run dev` 로 개발 서버 실행 후 브라우저에서 반품 페이지 → 판매자대기 탭 확인:
- 버튼이 "일반사유로변경 (N건 선택)" 하나만 보이는지.
- 항목 선택 후 버튼 클릭 → 모달에 체크박스 + 템플릿 드롭다운이 함께 보이는지.
- 체크박스 해제 상태로 템플릿 선택 후 "진행" → 사유변경 + 문자발송 메시지가 뜨는지 (기존 동작과 동일).
- 체크박스를 켜면 드롭다운이 비활성화되고, 템플릿을 고르지 않아도 "진행"이 활성화되는지 → 클릭 시 "일반사유 변경 완료(문자 미발송): X/N건 성공" 메시지가 뜨는지.
- 등록된 템플릿이 하나도 없는 계정/상태에서도 체크박스를 켜면 "진행"이 가능한지.

확인 후 개발 서버를 종료한다.

- [ ] **Step 9: 커밋**

```bash
git add "src/components/Barcode/ReturnsPage.jsx"
git commit -m "$(cat <<'EOF'
feat: merge returns reason-change SMS skip into template modal

EOF
)"
```

(주의: 이 리포지토리에는 이 작업과 무관한 기존 미커밋 변경사항이 다수 있음 — `src/components/Barcode/ReturnsPage.jsx` 한 파일만 명시적으로 add할 것, `git add -A`/`git add .` 금지.)
