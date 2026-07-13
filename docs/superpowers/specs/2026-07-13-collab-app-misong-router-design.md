# collab_app.py — 미송관리(misong) 라우터 등록 설계

## 배경

`https://yusaek.onrender.com`(사용자가 "배포앱"이라 부르는 서버)의 `openapi.json`을 직접 조회해본
결과, 이 서버는 `backend/main.py` 전체가 아니라 `backend/collab_app.py`(경량 협업 전용 서버,
CLAUDE.md에 문서화된 대로 `auth`/`collab`/`sms`/`attendance`/`guidebook`/`amood-settlement`만
등록)가 떠 있는 것으로 확인됐다. `misong_routes`는 애초에 import조차 되어 있지 않아, 프론트엔드
API 주소를 아무리 올바르게 고쳐도 미송관리는 404로 실패할 수밖에 없는 상태였다.

한편 `misong_items` 등 미송 데이터는 `main.py`에서 `get_db=_get_shared_db`로 연결되어 있고,
로컬(사무실 서버)의 `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`이 Render에 설정된 값과 완전히
동일함을 확인했다 — 즉 데이터는 이미 로컬·배포가 공유하는 Turso DB에 실시간으로 쌓이고 있다
(확인 시점 기준 72행). 따라서 데이터 이전(마이그레이션)은 필요 없고, `collab_app.py`에
`misong_routes`를 `main.py`와 동일한 방식으로 등록하기만 하면 된다.

## 요구사항 (사용자 확정)

- 로컬 DB 자체는 건드리지 않는다 (이미 공유 Turso를 쓰고 있으므로 해당 없음).
- `collab_app.py`에 `misong_routes`를 등록해서 배포 서버에서도 `/noye-kimsungil/misong/*`
  API가 응답하도록 한다.
- 프론트엔드 배포 빌드의 `VITE_LOCAL_API_BASE`가 `http://127.0.0.1:8000`으로 잘못 설정된
  문제는 이 스펙의 범위 밖이다 (배포 설정이라 사용자가 직접 수정) — 단, 이 코드 변경이 실제로
  효과를 보려면 그 값도 함께 고쳐져야 한다는 점을 명시한다.

## 변경 사항 (`backend/collab_app.py`)

1. import 추가:
   ```python
   from api.misong_routes import build_misong_router
   ```
2. 기존 `from main import (...)` 목록에 `_get_shared_db` 추가 (현재 `_get_db`만 있음).
3. 다른 `app.include_router(...)` 블록들 옆에 라우터 등록 추가:
   ```python
   app.include_router(
       build_misong_router(
           get_current_user=_get_current_user,
           get_db=_get_shared_db,
           get_setting=_get_setting,
       )
   )
   ```
   이는 `main.py:1431-1435`의 등록 코드와 완전히 동일하다 (동일한 함수 시그니처, 동일한
   의존성 이름).

## 범위 밖 (Out of scope)

- Render 쪽 collab_app.py 재배포는 사용자가 직접 수행.
- 프론트엔드 배포 빌드의 `VITE_LOCAL_API_BASE` 수정 및 재빌드/재배포는 사용자가 직접 수행.
- `misong_routes`가 사용하는 EZAdmin 연동(`_EZADMIN_SESSION_KEY` 등)은 `get_setting`을
  통해 `main.py`의 `_get_setting`을 그대로 재사용하므로 별도 처리 불필요.
