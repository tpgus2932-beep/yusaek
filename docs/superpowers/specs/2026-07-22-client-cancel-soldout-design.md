# 거래처 > 품절취소 탭: 상품 미진열 + 주문취소 + 품절문자 자동화

## 배경

`ClientCancelSoldOutPage.jsx`는 현재 "준비 중입니다" placeholder만 있는 빈 탭이다
(`docs/superpowers/specs/2026-07-22-client-menu-rename-and-tabs-design.md` 범위 밖으로 남겨둔 부분).

거래처에서 특정 상품이 품절되었을 때, 지금까지는 에이블리 셀러센터에서 수동으로
① 해당 상품을 검색해 미발송 주문을 찾고 → ② 주문취소 → ③ 상품을 미진열(비노출) 처리 →
④ 구매자에게 품절 안내문자를 보내는 과정을 반복해왔다. 이 탭에서 상품명만 입력하면
이 네 단계를 한 번에 자동 처리한다.

## 목표

사이드바 "거래처" > "품절취소" 탭에서:
1. 원가베이스유(`원가베이스유.xlsx`) 상품 검색으로 상품을 리스트에 추가
2. "실행" 버튼 한 번으로 그 상품들의 **미발송 주문 전체**를 취소 + 해당 옵션을 에이블리에서
   미진열 처리 + 취소된 주문의 구매자에게 품절문자 발송
3. 처리 결과(성공/실패 건수, 대상 목록)를 화면에 리포트

## 비범위

- 발송된/배송완료된 주문 처리(대상은 미발송 주문만)
- 원가베이스유 파일 자체의 편집 UI (기존 `/order/cost-base/search` 그대로 조회만)
- 품절문자 템플릿 편집 UI (기존 SMS 탭의 템플릿 관리 화면을 그대로 사용)

## 핵심 매칭 로직: 옵션번호

`원가베이스유.xlsx`의 11번째 열(K열, 0-index 10) **"옵션번호"**가 에이블리 주문상품의
`option_stock_sync_code` 값과 1:1로 일치한다 (실제 파일 확인 완료, 예: `175252569`).

상품명으로 검색하면 색상/사이즈별로 여러 행(=여러 옵션번호)이 나오는데, 이 옵션번호
집합을 그대로 "이 상품명으로 취소할 옵션"의 기준으로 쓴다. 문자열 옵션명("베이지/free")
매칭보다 안전하다 — 표기 차이(공백, 슬래시 등)에 영향받지 않음.

## 프론트엔드 설계 (`ClientCancelSoldOutPage.jsx`)

- **상품 추가**: 상품명 입력 → `GET {LOCAL_API_BASE}/order/cost-base/search?q=` 호출 →
  검색 결과(같은 상품명의 색상/사이즈 행들)를 리스트에 통째로 추가. 리스트 항목은
  상품명 단위로 표시하되 내부적으로 해당 옵션번호 배열을 들고 있음. 중복 상품명 추가 방지.
- **리스트 관리**: 추가된 상품 각각 삭제(x) 가능. 실행 전 상품명/옵션 개수 미리보기.
- **실행**: "실행" 버튼 → 리스트의 `[{name, option_codes: [...]}...]`를 신규 백엔드
  엔드포인트에 한 번에 POST → 결과 리포트(취소된 주문 수, 미진열 처리된 옵션 수,
  발송된 문자 수, 실패 목록)를 화면에 표시.
- **API base**: `LOCAL_API_BASE` 사용 (barcode/returns/exchange 등 다른 에이블리 연동
  탭과 동일한 규칙 — `COLLAB_API_BASE`가 아님. 이 작업은 실제 에이블리 판매 데이터를
  건드리는 운영 액션이라 collab/클라우드 서버가 아닌 로컬 백엔드에서 처리).
- **인증**: 기존 `barcode`/`returns`/`exchange-return` 라우터와 동일하게 `get_current_user`
  (관리자 전용 아님 — 사이드바에서 이미 일반 운영 탭으로 취급됨).
- EZDesk 세션 만료 시 기존 `need_ezdesk_session` 플래그 → 프론트에서 `useEzadminSession`
  훅으로 세션 재붙여넣기 안내 (barcode/return 관련 페이지들과 동일 패턴).

## 백엔드 설계

### 신규 파일: `backend/api/client_cancel_soldout_routes.py`

`build_client_cancel_soldout_router(get_current_user, get_setting)` 형태로 `main.py`에 등록.

### `backend/sdk/ably.py`에 메서드 추가

```python
async def search_order_items_by_goods_name(self, keyword: str, *, per_page: int = 30) -> list[dict]:
    """미발송 주문(processing_status=2) 중 상품명이 일치하는 order_items 전체 페이지 조회."""
    # GET /seller/order_items/, origin=my.a-bly.com
    # params: order=-checked_at, delivery_type[]=[standard,today,combine,reserved],
    #         processing_status[]=2, processing_sub_status[]=0,
    #         keyword=<goods_name>, keyword_type=goods_name, page, per_page
    # total-count 응답으로 총 페이지 수를 계산해 순회 (또는 max_page_number 필드 사용)

async def get_order_refund_info(self, order_sno: int | str) -> dict:
    """GET /seller/orders/{order_sno}/items/?processing_status[]=1&processing_status[]=2&processing_sub_status[]=0
    → order.refund_bank.sno, order.refund_bank_account_holder, order.refund_bank_account_number 반환"""

async def cancel_order_items(self, order_sno, sno_list, *, refund_bank_account_holder,
                              refund_bank_account_number, refund_bank_sno) -> dict:
    """POST /seller/order_items/receive_cancel/
    body: {order_sno, cancel_reason: 2, cancel_type: "cancel", sno_list, refund_bank_*}
    반환: {need_to_be_soldout_goods_list, need_to_be_non_display_option_list}"""

async def stop_selling(self, *, non_display_option_snos: list[int], soldout_goods_snos: list[int]) -> None:
    """POST /seller/goods/stop-selling/
    body: {need_to_be_non_display_option_sno_list, need_to_be_soldout_goods_sno_list}"""
```

모두 `origin="my.a-bly.com"`으로 기존 `self.request()` 헬퍼를 통해 호출 (재로그인 자동 처리).

### 처리 흐름 (`POST /client-cancel-soldout/run`)

입력: `{"products": [{"name": "빈티지 흑청 스커트", "option_codes": ["175252569", ...]}, ...]}`

1. **검색·매칭**: 상품명별로 `search_order_items_by_goods_name()` 호출 → 응답의
   `option_stock_sync_code`가 해당 상품의 `option_codes` 집합에 속하는 항목만 필터링.
   여러 상품이 있으면 상품별로 반복하되, 결과는 `order_sno` 기준으로 합쳐서 그룹핑
   (한 주문 안에 서로 다른 상품이 섞여 걸릴 수 있음 — 그 경우도 한 주문으로 묶어 처리).
2. **주문별 취소**: `order_sno` 그룹마다
   - `get_order_refund_info(order_sno)`로 환불계좌 조회
   - `cancel_order_items(order_sno, sno_list=<그 주문의 매칭 항목 전체>, ...)` 호출
   - 실패해도 계속 진행 (실패 사유를 결과 리스트에 기록, 전체 중단 안 함)
   - 성공 응답의 `need_to_be_non_display_option_list`/`need_to_be_soldout_goods_list`를
     누적 수집
3. **미진열/품절 일괄 반영**: 모든 주문 처리가 끝난 뒤, 누적된 옵션/상품 sno를
   **한 번만** `stop_selling()`으로 배치 호출 (중복 제거).
4. **품절문자 발송**: 취소에 성공한 주문마다, 그 주문에서 취소된 상품명들을
   `", "`로 join해 `{상품}`에 채운 "품절 문자" 템플릿(`sms_templates` 테이블, `name='품절 문자'`)을
   `EzAdminClient.send_sms(buyer_tel, EZDESK_SMS_SENDER, msg)`로 발송. 실패(세션 만료 등)는
   결과에 기록하고 계속 진행.

### 응답 형태

```json
{
  "ok": true,
  "cancelled_orders": [{"order_sno": ..., "product_names": [...], "sms_sent": true}],
  "failed_orders": [{"order_sno": ..., "reason": "..."}],
  "non_display_option_count": N,
  "soldout_goods_count": N,
  "need_ezdesk_session": false
}
```

## 품절 문자 템플릿

`sms_templates` 테이블의 `name='품절 문자'` 행, 본문 중 플레이스홀더는 **`{상품}`**
(다른 템플릿의 `{이름}`과 동일한 중괄호 변수 스타일로 통일 — 이번 세션에서 기존
`'---------'` 자리를 `{상품}`으로 이미 수정·저장함, 백업: `backend/app.db.backup-20260722-160037`).

한 주문에 취소 상품이 여러 개면 `{상품}` 자리에 **쉼표로 구분**해 나열
(예: `"빈티지 흑청 스커트 흑청 S, 노에 린넨 셔츠 그레이 free"`).

## 에러 처리 정책

- 검색/취소/미진열/문자발송 각 단계에서 **부분 실패는 전체를 막지 않는다** — 실패한
  주문/상품은 결과 리스트에 사유와 함께 남기고 나머지는 계속 처리.
- EZDesk 세션 만료(`EzDeskSessionExpired`)는 개별 문자 발송 실패로만 기록하고
  (이미 취소·미진열까지는 완료된 상태이므로) 전체 실행을 중단하지 않음 —
  응답의 `need_ezdesk_session: true`로 프론트에 알려 세션 재붙여넣기를 유도.
- 에이블리 로그인/네트워크 오류 등 검색 단계 자체가 실패하면 해당 상품 전체를
  건너뛰고 다음 상품으로 진행, 결과에 사유 기록.

## 테스트 계획

- 백엔드: 신규 `AblyClient` 메서드들에 대한 요청 바디/쿼리 파라미터 단위 테스트
  (HAR에서 확인한 실제 페이로드 형태와 일치하는지)
- 수동 검증: 개발 서버에서 실제 미발송 주문이 있는 테스트 상품으로 1건 실행해
  ① 에이블리 셀러센터에서 주문이 취소됐는지 ② 해당 옵션이 미진열 처리됐는지
  ③ 구매자 번호로 품절문자가 실제 발송됐는지 확인
