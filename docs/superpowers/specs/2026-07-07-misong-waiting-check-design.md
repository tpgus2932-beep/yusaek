# 미송 목록 vs EZAdmin 입고대기 수량 체크 — 설계 문서

**Goal:** 노예김승일 > 미송관리 탭에서 "입고대기설정" 실행 후, 로컬 미송 목록의 상품코드별 수량과 EZAdmin(I100 재고 목록)에 실제로 반영된 `stock_in_standby`(입고대기) 수량이 일치하는지 검증하는 "입고대기 체크" 버튼을 추가한다.

## 배경

- 미송관리 탭은 `misong_items` 테이블(상품코드=`original_f`, 수량=`F`)을 로컬에 유지한다.
- "입고대기설정" 버튼(`handleIngodaegiEzadmin`, `NoyeKimPage.jsx:1913` → `POST /noye-kimsungil/misong/waiting-base/export-to-ezadmin`, `misong_routes.py:1153`)은 미송 목록을 상품코드별로 합산한 뒤 EZAdmin(I200 템플릿)에 엑셀 업로드하여 입고대기 수량을 반영한다.
- 이 반영이 실제로 EZAdmin 쪽에 정확히 들어갔는지 확인할 방법이 없었다. EZAdmin의 재고 목록 화면(I100 템플릿)은 각 상품의 `stock_in_standby`(입고대기수량, HTML `<input>` 형태로 내려옴) 값을 보여주는데, 이를 조회해서 로컬 미송 수량과 비교하면 검증할 수 있다.

## 범위

- 신규 백엔드 엔드포인트 1개 (`misong_routes.py`)
- 프런트엔드 버튼 1개 + 결과 모달 1개 (`NoyeKimPage.jsx`)
- 기존 EZAdmin 세션(`need_session`) 처리 패턴, 기존 모달 스타일(`misongDisappearedOpen` 모달) 재사용

## 백엔드 설계

### 엔드포인트

`POST /noye-kimsungil/misong/waiting-base/check-ezadmin`

`export-to-ezadmin`과 동일하게 EZAdmin `PHPSESSID` 세션이 필요하며, 세션이 없으면 동일하게 `{"ok": false, "need_session": true}`를 반환한다 (프런트에서 기존 `openEzadminModal` 재사용).

### 1. 로컬 기대값 집계

`export-to-ezadmin`(`misong_routes.py:1165-1173`)과 동일한 쿼리를 공용 헬퍼로 뽑아서 재사용한다:

```sql
SELECT original_f, SUM(F) AS qty FROM misong_items
WHERE TRIM(original_f) != '' GROUP BY original_f
```

→ `{정규화된 상품코드: 미송수량}` 맵 (`_normalize_code` 재사용)

### 2. EZAdmin 실제값 조회

`template=I100&action=search`를 호출한다. 사용자가 캡처한 요청 파라미터를 그대로 사용하되:

- `start_date` / `end_date` / `start_date2` / `end_date2` → 요청 처리 시점의 오늘 날짜(`YYYY-MM-DD`)로 채운다 (버튼을 누른 날짜 기준, 캡처 당시 하드코딩된 날짜 대신).
- `nd` → 호출 시점의 epoch ms (기존 `ts_ms` 패턴과 동일).
- `rows` → `5000`으로 늘려서 한 번의 호출로 전체 목록을 받는 것을 기본으로 하되, 응답의 `total`(총 페이지수)이 1보다 크면 `page`를 증가시키며 반복 조회한다 (안전장치, 상한 20페이지).
- 그 외 파라미터(`stock_type=2`, `query_type=name`, `query_str=` 등)는 캡처된 값 그대로 고정 사용.

각 응답 row의 `cell`에서:
- `key` → 상품코드 (이미 순수 텍스트, 별도 파싱 불필요)
- `stock_in_standby` → HTML 문자열에서 정규식 `org_value='([^']*)'`로 값 추출 (없으면 0)

→ `{정규화된 상품코드: EZAdmin 입고대기수량}` 맵. **단, 값이 0인 항목은 맵에서 제외한다.** 전체 재고 목록에는 입고대기수량이 0인 상품이 수백~수천 건 있을 수 있는데, 이를 그대로 포함하면 아래 비교 로직에서 "미송에 없음" 오탐이 전체 재고 규모만큼 쏟아진다.

### 3. 비교 로직

두 맵의 상품코드 합집합에 대해 각각 판정:

| 상황 | 판정 |
|---|---|
| 양쪽에 코드 존재 + 수량 같음 | 정상 (응답에는 포함하지 않음) |
| 양쪽에 코드 존재 + 수량 다름 | `qty_mismatch` |
| 미송에만 존재 (EZAdmin 목록에 코드 없음) | `code_not_found_in_ezadmin` |
| EZAdmin에만 존재 (입고대기수량 > 0인데 미송 목록엔 없음) | `not_in_misong` |

### 응답 형태

```json
{
  "ok": true,
  "checked_at": "2026-07-07T12:34:56+09:00",
  "misong_code_count": 12,
  "ezadmin_code_count": 340,
  "mismatches": [
    {"code": "S14764", "misongQty": 60, "ezadminQty": 65, "reason": "qty_mismatch"},
    {"code": "S99999", "misongQty": 10, "ezadminQty": null, "reason": "code_not_found_in_ezadmin"},
    {"code": "S24589", "misongQty": null, "ezadminQty": 12, "reason": "not_in_misong"}
  ]
}
```

- EZAdmin 호출/파싱 실패 시: `{"ok": false, "error": "..."}` (기존 패턴과 동일하게 예외를 잡아 메시지로 반환)

## 프런트엔드 설계

### 상태 (NoyeKimPage.jsx)

- `misongCheckOpen` (bool)
- `misongCheckLoading` (bool)
- `misongCheckResult` (백엔드 응답 객체 또는 null)

### 버튼

미송관리 툴바에서 "입고대기설정" 버튼(2305~2311행) 바로 옆에 추가:

```jsx
<button
  className={styles.secondaryBtn}
  onClick={handleMisongCheckEzadmin}
  disabled={misongCheckLoading || misongItems.length === 0}
>
  <Search size={13} />{misongCheckLoading ? "확인 중..." : "입고대기 체크"}
</button>
```

`handleMisongCheckEzadmin`은 `handleIngodaegiEzadmin`과 동일한 구조(fetch → `need_session`이면 `openEzadminModal` → 결과 저장) 이되, 성공 시 `setMisongCheckResult(data); setMisongCheckOpen(true);`.

### 결과 모달

기존 `misongDisappearedOpen` 모달(2657행 부근)과 동일한 `styles.modalOverlay` / `styles.modal wideModal` 레이아웃 재사용:

- 헤더: "입고대기 체크 결과"
- 불일치 0건: `✅ 전체 일치 (미송 {misong_code_count}건 / EZAdmin {ezadmin_code_count}건 확인)` 한 줄
- 불일치 있음: 상단에 `⚠️ 불일치 {mismatches.length}건` + 표
  - 컬럼: 상품코드 | 미송수량 | EZAdmin수량 | 상태
  - 상태 배지 텍스트: `qty_mismatch` → "수량불일치", `code_not_found_in_ezadmin` → "코드매칭안됨", `not_in_misong` → "미송없음"
  - 기존 `misongBadgeNegative` / `misongBadgeMissing` / `misongBadgeNotFound` CSS 클래스 재사용 (색상 매핑: qty_mismatch→negative, code_not_found_in_ezadmin→missing, not_in_misong→notFound)

## 에러 처리

- EZAdmin 세션 만료: 기존 `need_session` → `openEzadminModal(handleMisongCheckEzadmin)` 재시도 패턴
- 네트워크/파싱 실패: 모달을 열지 않고 `ingodaegiMsg` 자리처럼 별도 상태(`misongCheckLoading` 해제 + 에러 메시지를 `message` 상태에 표시)로 알림

## 테스트 관점

- 자동 테스트 스위트 없음 (CLAUDE.md 명시) — 수동 검증: 미송 목록에 있는 상품코드 중 하나의 EZAdmin 값을 의도적으로 다르게 만든 뒤 버튼을 눌러 불일치가 정확히 잡히는지 확인.
