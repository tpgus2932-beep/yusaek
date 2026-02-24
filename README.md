# YUSAEK Admin Dashboard

React(Vite) + FastAPI 기반 내부 운영 도구입니다.  
주요 기능은 `바코드`, `반품`, `아무드`, `요청/공유파일`, `관리자`입니다.

## 주요 기능

- 인증/권한: 회원가입, 로그인, 관리자 권한 관리
- 바코드: 송장/상품 스캔, 불량 집계, 상품 업로드 가공
- 아무드: 엑셀 업로드/전처리/스캔/선적바코드 추출
- 반품: 엑셀 2종 매핑, 스캔 큐 관리, 원베 양식/대기 데이터 추출
- 협업: 요청 등록/완료/확인, 공유 파일 업로드/다운로드
- 회사 계정: PIN 기반 조회, 관리자 수정

## 기술 스택

- Frontend: React, Vite, CSS Modules
- Backend: FastAPI, Uvicorn, SQLite
- Data: pandas, openpyxl, xlrd/xlwt
- Auth: passlib, python-jose(JWT)

## 프로젝트 구조

```text
.
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── app.db
│   ├── api/
│   │   ├── auth_admin_routes.py   # auth + users + admin
│   │   ├── barcode_routes.py      # /barcode/*
│   │   ├── amood_routes.py        # /amood/*
│   │   ├── returns_routes.py      # /returns/*
│   │   ├── collab_routes.py       # requests/shared-files/company-credentials
│   │   └── amood_hapbae.py
│   ├── services/
│   │   ├── easyadmin_product.py
│   │   ├── amood_utils.py
│   │   └── returns_utils.py
│   └── uploads/
├── src/
│   ├── App.jsx
│   └── components/
└── package.json
```

## 실행 방법

1. 프런트엔드

```bash
npm install
npm run dev
```

2. 백엔드

```bash
python -m pip install -r backend/requirements.txt
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

- Frontend: `http://localhost:5173`
- Backend: `http://127.0.0.1:8000`
- 프런트는 기본적으로 `http://<현재호스트>:8000` API를 호출합니다.

## 환경 변수

- `JWT_SECRET` (기본: `dev-secret-change-me`)
- `RETURN_COST_BASE_PATH` (반품 원가 베이스 파일 경로)
- `BOOTSTRAP_ADMIN_USERNAME` (기본: `ksh2932`)
- `BOOTSTRAP_ADMIN_PASSWORD` (기본: 빈 값)
- `BOOTSTRAP_ADMIN_DISPLAY_NAME` (기본: `관리자`)
- `AMOOD_HAPBAE_COST_BASE_PATH` (아무드합배 원가 베이스 경로)

## API 기능 맵

- 인증/관리자: `auth_admin_routes.py`
- 바코드: `barcode_routes.py`
- 아무드: `amood_routes.py`
- 반품: `returns_routes.py`
- 요청/공유파일/회사계정: `collab_routes.py`

## 유지보수 가이드

- 신규 기능은 `backend/api/`의 해당 도메인 라우터에 추가
- 엑셀/문자열 가공 로직은 `backend/services/`로 이동 후 라우터에서 호출
- `main.py`는 앱 초기화와 라우터 등록만 유지

## 보안 주의

- 운영 환경에서는 `JWT_SECRET`을 반드시 변경하세요.
- `BOOTSTRAP_ADMIN_PASSWORD`를 비워두지 마세요.
