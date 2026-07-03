# 합배 구성 선매칭 — 등록상품 매칭 카드 설계

## 배경

`사이드메뉴 > 테스트 > 합배 구성 선매칭` (`src/components/Test/HapbaePreMatch.jsx`) 페이지는
바코드 메뉴에서 업로드한 확장주문검색 엑셀(`state["hapbae_pre_match_rows"]`, 사용자별 상태)과
입고파일 수량(`get_shared_incoming_counts()`, 전역 공유 상태)을 대조해 대량합포/짤합포/입고없음/
재고대량/TODAY 대량 섹션을 보여준다.

이번 요청은 여기에 맨 하단 카드를 하나 추가하는 것: 원가베이스유(`wonbe` DB)에서 상품을 검색해
"관심상품"으로 등록해두면, 그 상품이 확장주문검색과 입고파일 양쪽에 모두 존재할 때만 상품정보와
수량을 보여준다. 수량은 입고파일 수량을 넘지 않도록 캡핑한다.

## 요구사항 (사용자 확정)

- 등록은 원가베이스유 검색을 통해 이루어진다 (기존 `/wonbe/search` API 재사용).
- 등록된 상품 중 확장주문검색 + 입고파일에 **둘 다** 존재하는 것만 카드에 표시한다.
  매칭되지 않은 등록 상품은 화면에 나타나지 않는다 (등록 자체는 유지됨).
- 표시 수량 = `min(확장주문검색 주문수량 합계, 입고파일 수량)`.
- 등록 UI는 카드 내부의 검색창 + 드롭다운 결과 방식 (모달 없음).

## 백엔드 변경 (`backend/api/barcode_routes.py`)

### 저장소

기존 `test_hapbae_checked_rows` 전역 설정 패턴(`get_setting`/`set_setting`)을 그대로 따라
새 전역 설정 키를 추가한다:

```python
hapbae_registered_products_key = "test_hapbae_registered_products"
```

값은 JSON 배열, 각 항목은 `{"code": str, "label": str}`. `code`는
`normalize_to_yusas()`를 거친 값(다른 코드 매칭과 동일 정규화), `label`은 UI 표시용
(예: `"{거래처} / {상품명합}"`).

헬퍼 함수 (`_get_hapbae_checked_rows`/`_set_hapbae_checked_rows`와 동일 형태):

```python
def _get_registered_products() -> list[dict]:
    raw = get_setting(hapbae_registered_products_key) or "[]"
    ...  # JSON 파싱, code/label 문자열 정제, code 중복 제거

def _set_registered_products(items: list[dict]) -> list[dict]:
    ...  # 정제 후 set_setting에 저장, 정제된 리스트 반환
```

### 엔드포인트

```
GET    /barcode/hapbae-pre-match/registered
POST   /barcode/hapbae-pre-match/registered   body: {code, label}
DELETE /barcode/hapbae-pre-match/registered   body: {code}
```

- `GET`: `{"ok": True, "registered": [...]}`
- `POST`: code가 비어있으면 400. 기존 목록에 같은 code 있으면 label만 갱신(또는 무시), 없으면 추가.
  갱신된 전체 목록을 `{"ok": True, "registered": [...]}` 로 반환.
- `DELETE`: code로 필터링해 제거 후 동일한 형태로 반환.

### 매칭 계산 (기존 `GET /barcode/hapbae-pre-match` 확장)

기존 핸들러 내부, `source_rows`/`incoming_counts`를 이미 구했으므로 그 뒤에 추가:

```python
registered = _get_registered_products()
registered_rows = []
for item in registered:
    code = item.get("code") or ""
    if not code:
        continue
    matches = [r for r in source_rows if (r.get("code") or "") == code]
    order_qty = sum(to_int(r.get("orderQty"), default=0) for r in matches)
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
```

주의: 이 매칭은 다른 섹션들과 달리 `target_shop_key`("에이블리(유색)") 필터를 적용하지
않는다 — 등록 상품은 특정 매장에 국한되지 않는 범용 관심상품 매칭이므로 `source_rows`
전체(모든 매장)를 대상으로 코드만 비교한다.

응답에 `"registered_rows": registered_rows` 필드를 추가한다. `state.get("loaded")`가
False인 조기 반환 경로에도 `"registered_rows": []`를 추가해 프론트에서 항상 필드가
존재하도록 한다.

## 프론트엔드 변경 (`src/components/Test/HapbaePreMatch.jsx`)

### 상태 추가

- `registeredProducts` — 등록 목록 (`{code, label}[]`), 마운트 시 `GET .../registered`로 로드
- `registeredMatches` — `loadRows()` 응답의 `registered_rows`를 그대로 저장
- `productSearch`, `productResults`, `productSearchLoading` — 원가베이스유 검색 상태
  (JanggiTable.jsx의 기존 상품 검색 패턴과 동일하게 250ms 디바운스 `useEffect`로 구현)

### UI

기존 섹션들과 같은 `styles.section` / `sectionHeader` (클릭 시 펼침/접힘, 배지에
`매칭 N건` 표시) 카드를 배열 맨 끝에 추가한다.

펼쳤을 때 표시 내용 (위에서 아래로):

1. 검색창 (`placeholder="상품코드/상품명/거래처 검색"`) — 입력 시 `/wonbe/search?q=...&limit=20`
   호출, 입력창 바로 아래 드롭다운으로 결과 렌더링. 각 결과 클릭 시:
   - `POST /barcode/hapbae-pre-match/registered` 호출 (`code`, `label`은
     `"{거래처} / {상품명합}"` 형태로 구성)
   - 성공하면 `registeredProducts` 갱신, 검색창/결과 초기화
2. 등록된 상품 목록을 작은 칩(pill) 형태로 표시, 각 칩에 × 버튼 → 클릭 시 확인 없이
   바로 `DELETE`(다른 목록 삭제와 달리 즉시 처리 — 파괴적이지 않고 되돌리기 쉬운 작업이므로
   `window.confirm` 불필요)
3. 매칭 결과 테이블 (컬럼: 상품명 / 옵션명 / 개수 / 입고수량), 기존 `renderTable`과 동일한
   스타일. `registeredMatches`가 비어 있으면 "매칭된 등록 상품이 없습니다." 안내 문구.

### 데이터 흐름

- 페이지 마운트: `loadRows()`(기존, `registered_rows` 포함하도록 이미 확장됨) +
  신규 `loadRegisteredProducts()`를 병렬 호출
- 등록/해제 후에는 `registeredProducts`만 갱신하면 되고, 매칭 재계산은 다음
  새로고침(`loadRows`) 시 반영됨 — 등록 직후 즉시 매칭을 보고 싶다면 등록 성공 시
  `loadRows()`도 함께 호출한다 (재조회 비용이 낮으므로 이 방식 채택).

## 에러 처리

- 검색/등록/해제 API 실패 시 기존 페이지의 `message` 상태에 에러 메시지 표시 (다른 액션들과
  동일한 패턴), 상태 롤백은 불필요(등록 목록은 서버 응답으로 항상 갱신되므로 낙관적 업데이트
  없이 응답 대기 후 반영).

## 범위 밖

- 등록 상품의 매장 필터링, 수량 임계값 설정 등 추가 옵션 없음 (YAGNI)
- 등록 목록은 전역 공유 설정이며 사용자별 분리 없음 (기존 체크 상태와 동일한 정책)
