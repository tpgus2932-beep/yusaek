# 외부 API 레퍼런스

## 목차
- [에이블리 (Ably)](#에이블리-ably)
- [Pastelco](#pastelco)
- [이지어드민 (EZAdmin)](#이지어드민-ezadmin)

---

## 에이블리 (Ably)

**Base URL:** `https://api.a-bly.com`  
**인증:** JWT 토큰 — `pastelco_login()` 호출로 획득  
**토큰 위치:** 모든 요청의 `Authorization: JWT {token}` 헤더

### 인증

#### 로그인
```
POST /seller/login/
```
**Headers:**
```
Content-Type: application/json
Origin: https://my.a-bly.com
Referer: https://my.a-bly.com/
```
**Body:**
```json
{ "email": "...", "password": "..." }
```
**Response:** `{ "token": "..." }`

> 프로젝트 내 `pastelco_login()` (`backend/services/pastelco_utils.py`) 사용 권장.

---

### 헤더 패턴

에이블리 API는 호출 목적에 따라 두 가지 Origin을 사용한다.

| 용도 | Origin / Referer |
|------|-----------------|
| 주문·정산·입고전표 조회 (읽기) | `https://my.a-bly.com` |
| 재고·교환·반품 변경 (쓰기) | `https://seller-admin.a-bly.com` |

**읽기용 공통 헤더:**
```python
{
    "Authorization": f"JWT {token}",
    "Accept": "application/json",
    "Origin": "https://my.a-bly.com",
    "Referer": "https://my.a-bly.com/",
    "User-Agent": "Mozilla/5.0",
}
```

**쓰기용 공통 헤더:**
```python
{
    "Authorization": f"JWT {token}",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Origin": "https://seller-admin.a-bly.com",
    "Referer": "https://seller-admin.a-bly.com/",
    "User-Agent": "Mozilla/5.0",
}
```

---

### 주문 (Order Items)

#### 주문 목록 조회
```
GET /seller/order_items/
```
**Query params:**

| 파라미터 | 설명 | 예시 |
|---------|------|------|
| `processing_status[]` | 주문 상태 코드 | `2` (상품준비중) |
| `page` | 페이지 번호 | `1` |
| `page_size` | 페이지당 건수 | `100` |

**주문 상태 코드:**
| 코드 | 상태 |
|------|------|
| `2` | 상품준비중 |

**사용처:** `jeju_hapbae.py` — 제주합배 에이블리 불러오기

#### 주문 단건 조회 / 수정
```
GET  /seller/order_items/{order_item_sno}/
PATCH /seller/order_items/{order_item_sno}/
```
**사용처:** `exchange_return_routes.py`, `ably_settlement_utils.py`

#### 구매확정 요청
```
POST /seller/order_items/request_confirm/
```
**Body:**
```json
{ "order_item_snos": [123, 456] }
```
**사용처:** `returns_routes.py`

---

### 교환·반품 (Exchanges / Cancels)

#### 교환 목록 조회
```
GET /seller/exchanges/
```
**Query params:**

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| `status[]` | `2` | 교환요청 (회수접수 대기) |
| `status[]` | `3` | 교환송장등록 (반송장 등록 후) |
| `requested_at_start` | `YYYY-MM-DD HH:MM:SS` | 요청일 시작 |
| `requested_at_end` | `YYYY-MM-DD HH:MM:SS` | 요청일 종료 |
| `page` / `per_page` | 숫자 | 페이지 |

**Response 주요 필드:**
```json
{
  "exchanges": [
    {
      "sno": 123,
      "reason_code": "change_mind",
      "detail_reason": "...",
      "requested_at": "2026-06-19 10:00:00",
      "member": { "name": "홍길동" },
      "return_delivery": { "invoice_number": "1234567890" },
      "exchange_items": [
        {
          "order_item_sno": 456,
          "goods_name": "상품명",
          "option_info": "옵션",
          "order_item": { "invoice": "원송장번호" }
        }
      ]
    }
  ],
  "max_page_number": 3
}
```
> `sno`와 `exchange_sno` 두 필드 모두 존재할 수 있음. `ex.get("sno") or ex.get("exchange_sno")` 패턴 사용.

**사용처:** `exchange_return_routes.py`

#### 교환 승인 (Approve)
```
POST /seller/exchanges/approve/
```
**Headers:** 쓰기용 (`seller-admin.a-bly.com`)  
**Body:**
```json
{
  "exchanges": [
    {
      "sno": 123,
      "reason_code": "change_mind",
      "detail_reason": "단순변심"
    }
  ]
}
```
> HTTP 200이어도 body에 에러가 담길 수 있으니 response body 확인 필요.

**사용처:** `exchange_return_routes.py` (`process-exchange-pickup`)

#### 교환 반송장 등록
```
POST /seller/exchanges/{exchange_sno}/return-delivery-tracking/
```

#### 취소·반품 목록 조회 (회수접수 대기)
```
GET /seller/order_cancels/
```
**Query params:**

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| `cancel_type` | `return` | 반품만 조회 |
| `processing_sub_status[]` | `41` | 회수접수 대기 상태 |
| `delivery_type[]` | `standard`, `today`, `combine`, `reserved` | 배송 타입 (복수 전달) |
| `order` | `cancel_received_at` | 정렬 기준 |
| `date_type` | `cancel_received_at` | 날짜 필터 기준 |
| `start_date` / `end_date` | `YYYY-MM-DD` | 날짜 범위 |
| `page` / `per_page` | 숫자 | 페이지 |

**Response 주요 필드:**
```json
{
  "order_cancels": [
    {
      "buyer_tel": "01012345678",
      "receiver_name": "홍길동",
      "order_items": [
        {
          "sno": 789,
          "invoice": "1234567890",
          "goods_name": "상품명",
          "buyer_tel": "01012345678",
          "receiver_tel": "01012345678"
        }
      ]
    }
  ],
  "max_page_number": 2
}
```
> 전화번호는 cancel 레벨과 `order_items[0]` 레벨 양쪽에 있음. `buyer_tel` / `receiver_tel` 모두 확인 필요.

**사용처:** `return_shipping_routes.py` (`process-return-pickup`)

#### 반품 접수 요청
```
PUT /seller/order_items/request_return/
```
**Headers:** 읽기용 (`my.a-bly.com`)  
**Body:**
```json
{ "sno_list": [789, 790] }
```
> `sno_list`는 `order_items[].sno` 값 목록.

**사용처:** `return_shipping_routes.py` (`process-return-pickup`)

#### 취소·반품 상태 업데이트
```
PATCH /seller/order_cancels/update_fields/
```

---

### 상품 (Goods)

#### 상품 검색
```
GET /seller/goods/search/
```

#### 상품 단건 조회
```
GET /seller/goods/{sno}/
```

#### 재고 일괄 변경 (엑셀 업로드)
```
POST /seller/goods/options-bulk-update/stock/
```
**Body:** `multipart/form-data`  
`file`: xlsx 파일 (`에이블리재고변경.xlsx`)

**사용처:** `noye_kimsungil_routes.py`

#### 배송 타입 일괄 변경
```
POST /seller/goods/option-delivery-type-in-bulk/
```
**사용처:** `noye_kimsungil_routes.py`

---

### 당일출발 상품옵션 (Today Delivery)

#### 당일출발 옵션 목록
```
GET /seller/today-delivery-goods-options/
```

#### 당일출발 옵션 일괄 업데이트
```
PATCH /seller/today-delivery-goods-options/bulk-update/
```
**사용처:** `ably_minus_routes.py`

---

### 정산 (Balance Accounts)

#### 정산 내역 목록
```
GET /seller/balance_accounts/histories/
```
**Query params:** `start_month`, `end_month` (YYYY-MM)

#### 정산 내역 단건 다운로드
```
GET /seller/balance_accounts/histories/{sno}/download/
```
**사용처:** `ably_settlement_utils.py`

---

## Pastelco

**Base URL:** `https://api.pastelco.jp`  
**인증:** 에이블리 JWT 토큰 재사용 (`pastelco_login()`)

### 주문 (Orders)

#### 주문 목록 조회
```
GET /seller/orders/
```
**Query params:**

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| `status` | `SHIPPING_READYING` | 배송 준비중 |
| `status` | `SHIPPING_PROCESSING` | 배송 처리중 (당일 발주) |
| `shipping_processed_date_start` | `YYYY-MM-DD` | 발주일 시작 |
| `shipping_processed_date_end` | `YYYY-MM-DD` | 발주일 종료 |
| `page` | 숫자 | 페이지 번호 |
| `page_size` | 숫자 | 페이지당 건수 (기본 30) |
| `order_by` | `-order_placed_date` | 정렬 |

**Response 주요 필드:**
```json
{
  "order_line_items": [ { "product_option": { "option_values_origin": ["색상", "사이즈"] }, ... } ],
  "total_page": 3
}
```

**사용처:** `pastelco_utils.py` (`pastelco_fetch_all_orders`, `pastelco_fetch_shipping_processing_today`)

---

## 이지어드민 (EZAdmin)

**Base URL:** `https://ga80.ezadmin.co.kr`  
**인증:** PHPSESSID 쿠키 — DB `app_settings` 테이블에서 조회  
**공통 엔드포인트:** `POST /function.htm` (모든 요청 동일)  
**공통 헤더:**
```python
{
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://ga80.ezadmin.co.kr/template40.htm?template=I210",
    "X-Requested-With": "XMLHttpRequest",
}
```
**쿠키:** `{ "PHPSESSID": "..." }`

---

### I200 — 재고 입출고 (XLS 업로드 방식)

3단계 순서대로 호출해야 한다.

#### Step 1: XLS 업로드
```
POST /function.htm
```
**Form data:**
```
template=I200
action=upload_new
```
**Files:** `_file` = XLS 파일 (상품코드 / 작업수량 / 메모 3열)

**XLS 파일 형식:**
| 상품코드 | 작업수량 | 메모 |
|---------|---------|------|
| ABCD001 | 5 | 제주도합배 |

#### Step 2: 미리보기 (Preview)
```
POST /function.htm
```
**Form data:**
```
template=I200
action=load_template_data_new
_search=false
nd={timestamp_ms}
rows=99999
page=1
sidx=
sord=asc
```

#### Step 3: 적용 (출고 or 입고)
```
POST /function.htm
```
**Form data:**
```
template=I200
action=apply_new
bad=0
type={out | in}        ← 출고: out / 입고: in
move_warehouse=0
save_stock=0
stock_tag=
timeFlag={요일 월 일 연도 HH:MM:SS GMT+0900 (한국 표준시)}
```

**timeFlag 생성 예시 (Python):**
```python
datetime.now().strftime("%a %b %d %Y %H:%M:%S GMT+0900 (한국 표준시)")
# → "Wed Jun 18 2026 13:42:11 GMT+0900 (한국 표준시)"
```

**사용처:** `barcode_routes.py` (불량출고), `jeju_hapbae.py`, `amood_hapbae.py`, `misong_routes.py`

---

### IM00 — 입고전표 조회/생성

#### 전표 목록 조회 (Grid)
```
POST /function.htm
```
**Form data:**
```
template=IM00
action=get_IM00_grid
_search=false
nd={timestamp_ms}
rows=9999
page=1
sidx=
sord=asc
par=template=IM00&action=&page_code=IM00&search=1&_sort=&sort_order=&date_type=crdate&start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}&date_period_sel=0&query_option=title&query_str=&req_status=0
```
**Response:** `{ "rows": [ { "cell": { "sheet": "전표번호", "title": "전표명", ... } } ] }`

#### 전표 생성
기존 EZAdmin 공통 규칙과 동일하게 `POST /function.htm`, `PHPSESSID` 쿠키, `X-Requested-With: XMLHttpRequest` 헤더를 사용한다.

**Method:** `POST`  
**URL:** `https://ga80.ezadmin.co.kr/function.htm`  
**Content-Type:** `application/x-www-form-urlencoded; charset=UTF-8`  
**Referer 예시:** `https://ga80.ezadmin.co.kr/template40.htm?template=IM00`

**Form data:**
```
template=IM00
action=new_sheet_each
start_date={YYYY-MM-DD}
sheet_title={전표명}
timeFlag={브라우저 new Date().toString() 형식}
```

**샘플 요청 본문:**
```text
template=IM00&action=new_sheet_each&start_date=2026-06-18&sheet_title=AAA&timeFlag=Thu+Jun+18+2026+11%3A26%3A29+GMT%2B0900+(한국+표준시)
```

**파라미터:**
| 이름 | 설명 |
|------|------|
| `template` | `IM00` 고정 |
| `action` | `new_sheet_each` 고정. 새 전표 생성 |
| `start_date` | 전표 생성 기준일 |
| `sheet_title` | 전표명 |
| `timeFlag` | 브라우저 `new Date().toString()` 형식 문자열. 캐시 방지용 추정 |

**Response:** 성공 시 Response Body는 빈 값으로 확인됨. 생성된 전표번호는 응답에 포함되지 않는다.

**전표번호 확인:** 생성 후 전표번호가 필요하면 `전표 목록 조회 (Grid)`를 다시 호출해 `start_date`/`sheet_title` 기준으로 생성된 전표를 찾거나, 상세 URL에서 `sheet`/`seq` 값을 확인해야 한다.

**생성 후 처리:** EZAdmin 브라우저 화면은 생성 성공 후 `window.opener.search()`로 부모창의 전표 목록을 재조회한다.

**URL 인코딩 주의사항:**
- `sheet_title`은 한글/공백이 포함될 수 있으므로 URL/form encoding이 필요하다.
- `timeFlag`는 공백, `+`, 괄호, 한글이 포함될 수 있으므로 form data로 보내거나 인코딩해야 한다.

#### 전표 상품 일괄추가 (IM25 파일 업로드)
상품 일괄추가는 AJAX 요청이 아니라 `multipart/form-data` 파일 업로드 방식이다. 전표 상세 화면의 상품 일괄추가 버튼은 직접 API를 호출하지 않고 아래 팝업을 연다.

```javascript
openwin2(
  "popup35.htm?template=IM25&seq=" + SHEET_SEQ,
  "add_product_file",
  "650",
  "350" b    
)
```

**팝업 URL:** `https://ga80.ezadmin.co.kr/popup35.htm?template=IM25&seq={전표번호}`  
**`seq`:** IM00 전표번호

IM25 팝업 내부의 파일 업로드는 아래 폼 제출로 수행된다.

```html
<form
  method="post"
  enctype="multipart/form-data"
  target="_dummy"
  action="popup_utf8.htm">
```

**Method:** `POST`  
**URL:** `https://ga80.ezadmin.co.kr/popup_utf8.htm`  
**Content-Type:** `multipart/form-data`  
**Referer 예시:** `https://ga80.ezadmin.co.kr/popup35.htm?template=IM25&seq={전표번호}`

**Form data:**
```
template=IM25
action=upload
seq={전표번호}
_file={업로드할 엑셀파일}
```

**파라미터:**
| 이름 | 설명 |
|------|------|
| `template` | `IM25` 고정 |
| `action` | `upload` 고정. 상품 일괄추가 파일 업로드 |
| `seq` | IM00 전표번호 |
| `_file` | 업로드할 엑셀 파일. multipart 파일 필드 |

현재까지 확인된 기준으로 상품 일괄추가 자동화는 `popup_utf8.htm`에 `multipart/form-data`로 `_file`을 업로드하면 된다.

**TODO:** 성공/실패 응답 형식과 업로드 후 재조회 로직은 추후 분석 필요.

#### 전표 다운로드 작업 등록
```
POST /function.htm
```
**Form data:**
```
template=download
action=ins_download_worklist
work_template=IM00
work_func=save_file_IM00
par=template=IM00&action=save_file_IM00&filename=&page_code=IM10_file_2&sheet_list={전표번호,콤마구분}&download_type=1&select_code=IM00_file&date_type=crdate&start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}&date_period_sel=&multi_supply_group=undefined&multi_supply=undefined&str_supply_code=undefined
```

**사용처:** `barcode_routes.py` (입고 불러오기)

---

### I100 — 상품 검색

```
POST /function.htm
```
**Form data:**
```
template=I100
action=search
page_code=I100
_search=false
nd={timestamp_ms}
rows=1000
page=1
sidx=
sord=asc
par={검색 파라미터 문자열}
```
**사용처:** `noye_kimsungil_routes.py` (입고전표 상품 검색)

---

### IO30 — 오출(출고 조회)

```
POST /function.htm
```
**Headers에 Referer 변경:**
```
Referer: https://ga80.ezadmin.co.kr/template40.htm?template=IO30
```
**Form data:**
```
template=IO30 (또는 관련 템플릿)
_search=false
nd={timestamp_ms}
rows=1000
page=1
sidx=
sord=asc
```
**사용처:** `barcode_routes.py` (오출내리기), `order_routes.py` (메인발주 목록 조회)

---

### DS05 / DS00 — 배송CS 회수등록 (XLS 업로드 방식)

회수 처리는 2단계 순서로 호출한다.

#### Step 1: 송장번호 XLS 업로드 (DS05)
```
POST /popup35.htm
```
**Content-Type:** `multipart/form-data`  
**Referer:** `https://ga80.ezadmin.co.kr/popup35.htm?template=DS05&set_batch_cs=1`

**Form data:**
```
template=DS05
action=update_batch_cs
set_batch_cs=1
set_order_label=
```
**Files:** `_file` = XLS 파일 (1열: `송장번호`)

**XLS 파일 형식:**
| 송장번호 |
|---------|
| 1234567890 |

**Response:** HTML 본문에 `batch_cs_XXXXXXXX` 패턴의 `table_name` 포함  
→ 정규식 `r"batch_cs_\w+"` 으로 추출

#### Step 2: 회수 접수 등록 (DS00)
```
POST /function.htm
```
**Headers:**
```
X-Requested-With: XMLHttpRequest
Referer: https://ga80.ezadmin.co.kr/popup35.htm?template=DS05
```
**Form data:**
```
template=DS00
action=set_batch_cs
work=takeback
table_name={Step1에서 추출한 batch_cs_XXXXX}
cs_reason=일반
arr_product=[]
receiver_seq=8
receiver_name=유색
receiver_tel1=010
receiver_tel2=25466058
receiver_mobile1=010
receiver_mobile2=25466058
receiver_zip1=120
receiver_zip2=10
receiver_address=경기 남양주시 진접읍 장현리 51-1 롯데오성대리점 (유색)
trans_who=04
trans_due_date={YYYY-MM-DD}
timeFlag={브라우저 new Date().toString() 형식}
cs_content=
seq=
cancel_pack=0
recover_pack=0
delete_pack=0
priority=0
auto_restockin_all=0
auto_restockin_all_bad=0
restockin_ex=0
update_unhold=0
unhold=0
set_cs_top_fix=0
```

**사용처:** `return_shipping_routes.py`, `exchange_return_routes.py` (회수접수)

---

### S500 — 바코드 출력 HTML 생성

바코드 라벨 HTML 생성은 2단계 순서로 호출한다.

#### Step 1: 초기화
```
GET /popup35.htm
```
**Query params:**
```
template=S500
sheet_type=sheet_req
sheet={입고전표번호}
```
> 세션 확인 목적. 응답에 login 관련 키워드 있으면 세션 만료.

#### Step 2: 바코드 HTML 생성
```
POST /function.htm
```
**Headers:**
```
X-Requested-With: XMLHttpRequest
Referer: https://ga80.ezadmin.co.kr/popup35.htm?template=S500&sheet_type=sheet_req&sheet={전표번호}
```
**Form data:**
```
template=S500
action=make_html2
barcode_template=10009
formtec_start_num=
sheet={입고전표번호}
arr_product_id=["상품코드1","상품코드2"]     ← JSON 배열 문자열
arr_product_name=["상품명1","상품명2"]       ← JSON 배열 문자열
arr_product_option=["",""]                  ← JSON 배열 문자열 (빈 문자열 배열)
arr_qty=["1","2"]                           ← JSON 배열 문자열 (수량, 문자열 타입)
readonly=T
```

**Response:** HTML에 `/data/yusaek/XXXXXXXX.html` 경로 포함  
→ 정규식 `r"/data/yusaek/[^\"'<\s]+"` 으로 추출

#### Step 3: 생성된 HTML 조회
```
GET /data/yusaek/{파일명}.html
```
> 이 HTML을 브라우저 새 창에 `document.write()`로 쓰고 `print()` 호출.

**사용처:** `returns_routes.py` (`/returns/onebe/barcode-print`)

---

### 세션 관리

- PHPSESSID는 DB `app_settings` 테이블 `key='ezadmin_phpsessid'`에 저장
- 세션 만료 시 응답이 JSON이 아닌 HTML(로그인 페이지)로 옴 → `res.json()` 파싱 실패로 감지
- 응답 감지 패턴:
```python
try:
    data = res.json()
except Exception:
    return {"ok": False, "need_session": True}
```
