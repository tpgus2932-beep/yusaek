# 택배 이상현상 대시보드 카드 설계

## 배경

`배송현황 조회` 테스트 탭(`src/components/Test/DeliveryStatusTest.jsx`)에서 수동으로 하던 "에이블리 배송중 조회 → llogis 전체조회 → 안 움직이는 송장 찾기" 과정을, 매일 자동으로 수행해서 대시보드에 이상현상을 카드로 보여준다. 사용자가 매번 테스트 탭에 들어가서 확인하지 않아도, 대시보드만 봐도 문제 있는 송장을 알 수 있게 하는 것이 목적.

## 이상현상 판정 조건

에이블리 배송중 목록(`발송일`, `송장번호`)과 llogis 조회 결과(`배송상태`, `최종스캔일`)를 기준으로, 다음 중 하나라도 해당하면 이상현상으로 분류한다.

- `(오늘 - 발송일) >= 2일` 이면서 llogis에서 송장 자체를 찾을 수 없는 경우 (`invInfoList` 없음 — 다른 택배사이거나 미등록 송장)
- `(오늘 - 발송일) >= 2일` 이면서 `(오늘 - 최종스캔일) >= 3일` (스캔이 3일 이상 안 찍힌 경우)

두 조건 모두 "정확히 며칠 전"이 아니라 "그 이상 경과"를 포함하는 누적 조건이다. 즉 발송 후 2일이 지났는데 아직도 걸려 있는 오래된 이상 송장도 계속 잡힌다.

## 실행 방식 (스케줄링)

이 기능이 쓰는 API(`/return-shipping/*`)는 로컬 백엔드(`main.py`, 8000포트)에만 등록되어 있고 24/7 상시 구동되는 서버가 아니므로, OS/백엔드 레벨의 cron은 쓰지 않는다. 대신 기존 `wonbe/freshness-check` 패턴처럼 **대시보드를 여는 브라우저가 트리거**한다.

- 대시보드(`Overview.jsx`) 마운트 시, KST 기준 현재 시각이 16:00 이후면 `POST /delivery-anomaly/run` 호출
- 서버가 "오늘(KST) 이미 실행했는지"를 `app_settings` 키(`delivery_anomaly_last_run_date`)로 확인해서, 이미 실행했으면 외부 API를 다시 호출하지 않고 현재 저장된 목록만 반환 (여러 브라우저가 동시에 열려 있어도 중복 조회 안 함)
- 로컬 백엔드가 응답하지 않으면(오프라인/다른 네트워크) 조용히 무시하고, 카드는 마지막으로 저장된 목록만 보여준다

## 저장 구조

`_get_shared_db()` 사용 (사고화물 탭과 동일한 공유 DB 패턴).

```sql
CREATE TABLE delivery_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT NOT NULL UNIQUE,
    order_no TEXT,
    product_name TEXT,
    option_info TEXT,
    phone TEXT,
    sent_date TEXT,
    status TEXT,
    location TEXT,
    scan_date TEXT,
    reason TEXT,          -- 내부 기록용. 화면에는 별도 컬럼으로 노출하지 않음
    detected_at TEXT NOT NULL
);

CREATE TABLE delivery_anomaly_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anomaly_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

`resolved` 같은 완료 플래그는 두지 않는다. "확인완료" 버튼도 없다 — 매일 재계산 결과가 곧 진실이다.

### 매일 실행 시 diff 로직

1. 에이블리 배송중 목록 조회 + 송장번호 llogis 조회 (기존 `/return-shipping/ably-shipping`, `/return-shipping/llogis-check` 로직 재사용)
2. 위 조건에 맞는 송장번호 집합(오늘의 이상현상)을 계산
3. 기존 `delivery_anomalies`에 있는데 오늘 집합에 없는 행 → 삭제 (댓글도 cascade 삭제) — 즉 스스로 해결된 건은 카드에서 자동으로 사라진다
4. 오늘 집합에 있는데 기존에 없는 송장번호 → 새로 insert
5. 계속 조건에 맞는 송장번호는 건드리지 않음 (댓글 보존)
6. `app_settings.delivery_anomaly_last_run_date`를 오늘 날짜(KST)로 갱신

## API (`backend/api/delivery_anomaly_routes.py`, `main.py`에만 등록)

| Method | Path | 설명 |
|---|---|---|
| GET | `/delivery-anomaly/list` | 현재 이상현상 목록 (댓글 개수 포함), 외부 API 호출 없이 즉시 반환 |
| POST | `/delivery-anomaly/run` | 하루 1회 가드를 통과하면 조회+diff 실행 후 최신 목록 반환 |
| GET | `/delivery-anomaly/{id}/comments` | 해당 항목 댓글 목록 |
| POST | `/delivery-anomaly/{id}/comments` | 댓글 등록 (`text`, 작성자는 `get_current_user`) |

## 프론트엔드

신규 컴포넌트 `src/components/Dashboard/DeliveryAnomalyCard.jsx`, `Overview.jsx`의 `resolvedGrid`(공동 할 일 / 보낸 요청을 감싸는 grid) 바로 위에 전체 폭 카드로 삽입한다.

- 마운트 시 `GET /delivery-anomaly/list`로 즉시 렌더링, 이어서 16시 이후 조건이면 `POST /delivery-anomaly/run` 호출 후 목록 갱신
- 이상현상이 0건이면 카드 자체를 렌더링하지 않거나(또는 "이상현상 없음" 문구만) — 기존 대시보드의 다른 조건부 섹션과 동일하게 처리
- 표시 컬럼은 배송현황 조회 탭(`DeliveryStatusTest.jsx`)의 테이블과 동일하게 맞춘다: **주문번호 / 상품명 / 옵션 / 전화번호 / 발송일 / 송장번호 / 배송상태 / 위치 / 최종스캔일** (별도 "사유" 컬럼 없음)
- 각 행에 댓글 펼치기/접기 토글 — 기존 `Overview.jsx`의 요청 댓글 UI와 동일한 CSS 클래스 재사용 (`commentItem`, `commentMeta`, `commentAuthor`, `commentText`, `commentInputRow`, `commentInput`, `commentSubmitBtn`, `commentEmpty`)
- "확인완료" 버튼 없음

## 테스트/검증

- 백엔드: 조건 판정 함수(누적 2일/3일 경과, invInfoList 없음 케이스)에 대한 단위 테스트
- 프론트: 로컬에서 `main.py` 구동 후 `POST /delivery-anomaly/run` 수동 호출로 diff 동작(새로 추가/자동 삭제) 확인, 대시보드 카드 렌더링 및 댓글 등록 확인
