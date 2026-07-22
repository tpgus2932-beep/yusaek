# 이상현상 카드 오후 4시 서버 자동 실행 설계

## 배경 / 문제

대시보드의 세 이상현상 카드(배송이상, 반품 이상현상, 교환반품 이상현상)는 각각
`GET .../list`로 캐시된 목록을 보여주고, `POST .../run`으로 실제 외부 API(에이블리 /
LLogis)를 재조회해 DB에 반영한다. `.../run`은 이미 당일 실행 여부를
`_LAST_RUN_SETTING_KEY` 설정값으로 가드하고 있어 하루 1회만 실제 조회가 일어나도록
되어 있다.

문제는 이 재조회를 트리거하는 주체가 **프론트엔드뿐**이라는 점이다.
`DeliveryAnomalyCard.jsx`만 "페이지가 오후 4시(KST) 이후에 마운트되면 `/run`을 호출"하는
로직을 갖고 있고, 반품/교환반품 이상현상 카드는 그마저도 없다. 결과적으로 오후 4시가
지나도 아무도 대시보드를 열지 않으면 세 카드 모두 재조회가 일어나지 않는다.

## 목표

서버(백엔드) 프로세스가 켜져 있기만 하면, 아무도 대시보드를 열지 않아도 매일
KST 오후 4시 이후 세 이상현상 체크가 자동으로 1회씩 실행되어야 한다.

## 범위

- 배송이상(`delivery_anomaly_routes.py`)
- 반품 이상현상(`return_anomaly_routes.py`)
- 교환반품 이상현상(`exchange_return_anomaly_routes.py`)

프론트엔드 변경 없음 (기존 `DeliveryAnomalyCard.jsx`의 클라이언트 트리거 로직은 그대로
둔다 - 멱등하므로 무해한 백업 역할).

## 설계

### 1. 각 라우터: 실행 로직을 재사용 가능한 함수로 분리

세 라우터 모두 `POST /run` 핸들러 내부에 있는 실제 작업(외부 API 조회 → 이상 계산 →
DB 반영 → `_LAST_RUN_SETTING_KEY` 갱신)을 FastAPI의 `user: str = Depends(get_current_user)`
의존성과 분리된 순수 async 함수로 추출한다.

```python
async def _run_check_core(force: bool = False) -> None:
    today_str = datetime.now(_KST).strftime("%Y-%m-%d")
    last_run = get_setting(_LAST_RUN_SETTING_KEY)
    if str(last_run or "")[:10] == today_str and not force:
        return
    ... (기존 조회/계산/저장 로직) ...
    set_setting(_LAST_RUN_SETTING_KEY, datetime.now(_KST).isoformat())

@router.post("/run")
async def run_check(force: bool = False, user: str = Depends(get_current_user)):
    await _run_check_core(force=force)
    return list_anomalies(user=user)
```

`build_*_router(...)`가 반환하는 `router` 객체에 이 함수를 매달아 `main.py`가 접근할 수
있게 한다: `router.run_scheduled = _run_check_core` (각 라우터 `return router` 직전에 추가).
공개 API 시그니처(`build_*_router(...)`가 `router`를 반환한다는 점)는 바뀌지 않는다.

`_run_check_core`가 하는 일과 기존 `run_check` 핸들러가 하던 일은 동일하다 - 즉 수동
새로고침(`POST /run`, `force` 없음)의 "당일 이미 실행했으면 스킵" 동작은 지금과 완전히
동일하게 유지된다.

### 2. `main.py`: 백그라운드 스케줄러 태스크

현재 `app.include_router(build_delivery_anomaly_router(...))`처럼 반환값을 바로
`include_router`에 넘기고 있는 세 곳을, 변수로 받도록 바꾼다:

```python
_delivery_anomaly_router = build_delivery_anomaly_router(...)
app.include_router(_delivery_anomaly_router)
...
_exchange_return_anomaly_router = build_exchange_return_anomaly_router(...)
app.include_router(_exchange_return_anomaly_router)
...
_return_anomaly_router = build_return_anomaly_router(...)
app.include_router(_return_anomaly_router)
```

그 뒤 세 라우터의 `.run_scheduled`를 모아 이름과 함께 리스트로 구성하고, FastAPI
`startup` 이벤트에서 백그라운드 태스크를 하나 띄운다.

스케줄러는 "오늘 4시 자동 실행을 이미 했는지"를 각 라우터의 `_LAST_RUN_SETTING_KEY`와는
**별개의 키**로 추적한다 (사용자가 오후 4시 이전에 수동 새로고침을 눌러 그 키가 이미
오늘 날짜로 채워져 있어도, 4시 자동 실행은 항상 한 번 더 강제로 돌아야 하기 때문).

```python
_ANOMALY_SCHEDULER_JOBS = [
    ("delivery_anomaly", _delivery_anomaly_router.run_scheduled),
    ("return_anomaly", _return_anomaly_router.run_scheduled),
    ("exchange_return_anomaly", _exchange_return_anomaly_router.run_scheduled),
]

async def _anomaly_scheduler_loop():
    while True:
        try:
            now = datetime.now(_KST)
            if now.hour >= 16:
                today_str = now.strftime("%Y-%m-%d")
                for name, job in _ANOMALY_SCHEDULER_JOBS:
                    setting_key = f"anomaly_scheduler_ran_{name}"
                    if (_get_setting(setting_key) or "")[:10] == today_str:
                        continue
                    try:
                        await job(force=True)
                        _set_setting(setting_key, now.isoformat())
                    except Exception:
                        traceback.print_exc()  # 이 작업만 실패, 다음 5분에 재시도
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(300)  # 5분

@app.on_event("startup")
async def _start_anomaly_scheduler():
    asyncio.create_task(_anomaly_scheduler_loop())
```

- 폴링 주기는 5분.
- 세 작업은 순차 실행(동시에 에이블리/LLogis를 세 번 두드리지 않도록).
- 개별 작업 실패는 `traceback.print_exc()`로 콘솔에 남기고 다음 작업/다음 틱으로 넘어간다.
  `anomaly_scheduler_ran_{name}` 키는 **성공했을 때만** 오늘 날짜로 기록되므로, 실패한
  작업은 같은 날 다음 5분 틱에 자동으로 재시도된다.
- 자정을 넘기면 `today_str`이 바뀌므로 다음 날 다시 16시부터 정상적으로 트리거된다.

## 데이터 흐름

기존 `/run`과 동일 (에이블리 로그인 → 조회 → LLogis/계산 → DB 반영 →
`_LAST_RUN_SETTING_KEY` 갱신). 새로 추가되는 건 이 함수를 호출하는 진입점이 HTTP
요청 대신 백그라운드 태스크라는 점, 그리고 스케줄러 자체의 "오늘 4시 실행 여부"
설정값 하나가 작업당 추가되는 것뿐이다.

## 에러 처리

- 작업 1개 실패 → 해당 작업만 재시도 대상으로 남고 나머지 작업/루프는 계속 진행.
- 외부 API가 하루 종일 죽어있으면 계속 재시도하다가 자정에 포기하고 다음 날 다시 시도.
- 스케줄러 루프 자체가 죽지 않도록 최상위에도 `try/except`를 둔다.

## 테스트

- 기존 이상현상 로직 테스트(`test_delivery_anomaly_routes.py`,
  `test_delivery_anomaly_logic.py`, `test_delivery_anomaly_store.py`)는 변경 없음.
- 새 유닛 테스트: `_anomaly_scheduler_loop`의 게이팅 조건만 따로 뽑아 테스트 가능한
  형태로 - "16시 이전이면 아무 것도 호출 안 함", "16시 이후 & 오늘 미실행 스케줄러
  키 → force=True로 호출 후 키 기록", "16시 이후 & 오늘 이미 실행된 스케줄러 키 →
  호출 안 함", "작업 하나가 예외를 던져도 나머지 작업은 호출됨"을 실제 네트워크
  호출 없이 페이크 `run_scheduled`/`get_setting`/`set_setting`으로 검증.

## 비범위 (Out of scope)

- 폴링 주기를 설정 가능하게 만드는 것 (5분 고정으로 하드코딩).
- 다른 daily_check 항목(신규반품 회수신청 등)의 자동화 - 이번 스펙은 이상현상 3종만
  다룬다.
- APScheduler 등 외부 스케줄링 라이브러리 도입 - in-process asyncio 루프로 충분.
