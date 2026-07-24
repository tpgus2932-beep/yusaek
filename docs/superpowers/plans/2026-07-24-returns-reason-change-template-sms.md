# 일반사유로변경 시 템플릿 문자 동시 발송 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "일반사유로변경" 버튼을 누르면 사유변경 전에 SMS 템플릿을 고르게 하고, 사유변경 처리 후 선택된 각 건의 `buyer_tel`로 그 템플릿을 개별 발송한다.

**Architecture:** 프론트엔드(`ReturnsPage.jsx`)만 변경한다. 새 백엔드 엔드포인트는 없음 — 기존 `GET /sms/templates`(템플릿 목록), `POST /returns/ably-change-reason-submit`(사유변경, 기존 그대로), `POST /return-automation/reply-sms`(개별 문자 발송, 기존 그대로)를 순서대로 조합한다. 버튼 클릭 시 즉시 처리하던 것을 "클릭 → 템플릿 모달 → 진행 버튼 → (사유변경 → 문자 발송 루프)"로 바꾼다.

**Tech Stack:** React (`src/components/Barcode/ReturnsPage.jsx`). 프론트엔드는 자동화 테스트 없음 — `npm run lint` + 수동 브라우저 확인.

## Global Constraints

- 새 백엔드 엔드포인트를 만들지 않는다 — 기존 3개 엔드포인트만 재사용.
- 템플릿 문구는 변수치환 없이 원문 그대로 전송한다.
- `buyer_tel`이 빈 항목은 문자만 스킵하고 사유변경 자체는 그대로 진행한다 (사유변경 성공/실패와 무관하게 buyer_tel이 있으면 문자를 시도한다).
- 이지데스크 세션 만료(`need_ezdesk_session`)를 만나면 그 시점에서 문자 발송 루프를 멈춘다 (이미 보낸 건수는 유지, 나머지는 중단 안내).
- 판매자대기 탭의 다른 버튼(에이블리 환불 요청/이지어드민 입고처리/김승일보내기/바코드 출력)은 건드리지 않는다.

---

### Task 1: 템플릿 선택 모달 + 사유변경-문자발송 조합 로직

**Files:**
- Modify: `src/components/Barcode/ReturnsPage.jsx`

**Interfaces:**
- Consumes: 기존 `GET /sms/templates` (응답 `[{id, name, msg, title, msgType}]`), 기존 `POST /returns/ably-change-reason-submit`, 기존 `POST /return-automation/reply-sms`, 기존 `API`/`getAuthHeaders`/`setMessage`/`normalizeQueues`/`setQueues`
- Produces: 상태 `reasonChangeModalOpen`, `reasonChangeTemplates`, `reasonChangeTemplatesLoading`, `reasonChangeSelectedTemplateId`, `reasonChangePendingItems`, `reasonChangeConfirmLoading`. 함수 `openReasonChangeTemplateModal(selectedItems)`(버튼 onClick에서 호출), `closeReasonChangeTemplateModal()`, `handleConfirmReasonChangeWithSms()`. 버튼 onClick이 `handleAblyChangeReasonSubmit` 직접 호출에서 `openReasonChangeTemplateModal` 호출로 바뀐다 (`handleAblyChangeReasonSubmit` 자체는 그대로 남겨두되 더 이상 버튼에서 직접 쓰이지 않음 — 내부 fetch 로직은 `handleConfirmReasonChangeWithSms` 안에서 재사용).

- [ ] **Step 1: 상태 + 모달 open/close 함수 추가**

`src/components/Barcode/ReturnsPage.jsx`에서 `handleAblyChangeReasonSubmit` 함수(현재 426~448행) 바로 뒤에 추가:

```jsx
    const [reasonChangeModalOpen, setReasonChangeModalOpen] = useState(false);
    const [reasonChangeTemplates, setReasonChangeTemplates] = useState([]);
    const [reasonChangeTemplatesLoading, setReasonChangeTemplatesLoading] = useState(false);
    const [reasonChangeSelectedTemplateId, setReasonChangeSelectedTemplateId] = useState('');
    const [reasonChangePendingItems, setReasonChangePendingItems] = useState([]);
    const [reasonChangeConfirmLoading, setReasonChangeConfirmLoading] = useState(false);

    const openReasonChangeTemplateModal = async (selectedItems) => {
        if (!selectedItems || !selectedItems.length) return;
        setReasonChangePendingItems(selectedItems);
        setReasonChangeModalOpen(true);
        setReasonChangeSelectedTemplateId('');
        setReasonChangeTemplatesLoading(true);
        try {
            const res = await fetch(`${API}/sms/templates`, { headers: getAuthHeaders() });
            const data = await res.json().catch(() => ([]));
            const list = Array.isArray(data) ? data : [];
            setReasonChangeTemplates(list);
            if (list.length) setReasonChangeSelectedTemplateId(list[0].id);
        } catch {
            setReasonChangeTemplates([]);
        } finally {
            setReasonChangeTemplatesLoading(false);
        }
    };

    const closeReasonChangeTemplateModal = () => {
        setReasonChangeModalOpen(false);
        setReasonChangePendingItems([]);
        setReasonChangeSelectedTemplateId('');
    };

    const handleConfirmReasonChangeWithSms = async () => {
        const template = reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId);
        if (!template) {
            setMessage('템플릿을 선택하세요.');
            return;
        }
        const items = reasonChangePendingItems;
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
            const reasonOk = data.results.filter((r) => r.ok).length;

            let smsOk = 0;
            let smsSkipped = 0;
            let smsFailed = 0;
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
                    if (!smsRes.ok || smsData?.ok === false) {
                        smsFailed += 1;
                    } else {
                        smsOk += 1;
                    }
                } catch {
                    smsFailed += 1;
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

- [ ] **Step 2: 버튼 onClick을 모달 오픈으로 변경**

`src/components/Barcode/ReturnsPage.jsx`의 판매자대기 탭 "일반사유로변경" 버튼(현재 1592~1599행):

```jsx
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => handleAblyChangeReasonSubmit(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (${selectedSeller.size}건 선택)`}
                                    </button>
```

을 아래로 교체 (onClick만 변경):

```jsx
                                    <button
                                        type="button"
                                        className={pageStyles.primaryBtn}
                                        onClick={() => openReasonChangeTemplateModal(queues.seller.filter((i) => selectedSeller.has(i.id)))}
                                        disabled={reasonChangeLoading || selectedSeller.size === 0}
                                    >
                                        {reasonChangeLoading ? '처리 중...' : `일반사유로변경 (${selectedSeller.size}건 선택)`}
                                    </button>
```

- [ ] **Step 3: 템플릿 선택 모달 JSX 추가**

`src/components/Barcode/ReturnsPage.jsx`에서 기존 `smsComposeItem && (...)` 모달 블록(현재 2251행 시작) 바로 뒤, 컴포넌트 최상위 닫는 `</div>` 앞에 추가:

```jsx
            {reasonChangeModalOpen && (
                <div
                    onClick={closeReasonChangeTemplateModal}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'var(--bg-primary, #fff)',
                            borderRadius: 8,
                            width: 'min(480px, 90vw)',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                            <strong>일반사유로변경 — 문자 템플릿 선택 ({reasonChangePendingItems.length}건)</strong>
                            <button type="button" onClick={closeReasonChangeTemplateModal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
                        </div>
                        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {reasonChangeTemplatesLoading ? (
                                <div>템플릿 불러오는 중...</div>
                            ) : reasonChangeTemplates.length === 0 ? (
                                <div>등록된 템플릿이 없습니다. 사이드메뉴 "문자 발송"에서 템플릿을 먼저 만들어주세요.</div>
                            ) : (
                                <>
                                    <select
                                        value={reasonChangeSelectedTemplateId}
                                        onChange={(e) => setReasonChangeSelectedTemplateId(e.target.value)}
                                        style={{ padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6 }}
                                    >
                                        {reasonChangeTemplates.map((t) => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </select>
                                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: 'var(--text-secondary, #6b7280)', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, padding: 10, minHeight: 60 }}>
                                        {reasonChangeTemplates.find((t) => t.id === reasonChangeSelectedTemplateId)?.msg || ''}
                                    </div>
                                </>
                            )}
                            <button
                                type="button"
                                className={pageStyles.primaryBtn}
                                onClick={handleConfirmReasonChangeWithSms}
                                disabled={reasonChangeConfirmLoading || reasonChangeTemplatesLoading || !reasonChangeSelectedTemplateId}
                            >
                                {reasonChangeConfirmLoading ? '처리 중...' : '진행'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
```

- [ ] **Step 4: Lint 실행**

Run: `npm run lint`
Expected: 이 변경으로 인한 새 에러/경고 없음 (기존에 있던 무관한 에러는 그대로 남아있어도 됨)

- [ ] **Step 5: 커밋**

```bash
git add src/components/Barcode/ReturnsPage.jsx
git commit -m "feat: prompt for SMS template before bulk reason-change and send it per item"
```

---

### Task 2: 수동 브라우저 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 개발 서버가 이미 떠 있지 않다면 백엔드/프론트 재기동**

Run: `cd backend && uvicorn main:app --reload --host 127.0.0.1 --port 8000` / `npm run dev`

- [ ] **Step 2: 브라우저 확인**

`http://localhost:5173` → 반품 → 판매자 대기 탭에서 1건 이상 체크 → "일반사유로변경" 클릭 →

1. 템플릿 모달이 뜨는지, 드롭다운에 실제 등록된 템플릿들이 보이는지 확인.
2. 템플릿 선택 시 미리보기 문구가 바뀌는지 확인.
3. "진행" 클릭 → 사유변경이 처리되고, 이어서 해당 건의 buyer_tel로 실제 문자가 가는지 확인.
4. buyer_tel이 없는 건이 섞여 있을 때 그 건은 문자만 스킵되고 나머지는 정상 처리되는지 확인.
5. 결과 메시지에 "사유변경 X/N건 성공. 문자 전송: Y/Z건 성공" 형태가 뜨는지 확인.

- [ ] **Step 3: 문제 없으면 완료 보고**
