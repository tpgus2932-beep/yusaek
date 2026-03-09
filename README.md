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

협업 기능만 별도 서버로 실행:

```bash
python -m pip install -r backend/requirements.txt
cd backend
uvicorn collab_app:app --reload --host 0.0.0.0 --port 8100
```

Windows에서는 전용 실행 파일 사용 가능:

```bat
start_yusaek_collab.bat
```

- Frontend: `http://localhost:5173`
- Backend: `http://127.0.0.1:8000`
- 프런트는 기본적으로 `http://<현재호스트>:8000` API를 호출합니다.
- 협업 기능만 별도 서버로 분리하려면 `.env`에 `VITE_COLLAB_API_BASE`를 지정하면 됩니다.
- 협업 전용 서버 예시: `http://127.0.0.1:8100`

## 환경 변수

- Frontend
  - `VITE_LOCAL_API_BASE` (기본: `http://<현재호스트>:8000`)
  - `VITE_COLLAB_API_BASE` (기본: `VITE_LOCAL_API_BASE`와 동일)
- `JWT_SECRET` (기본: `dev-secret-change-me`)
- `RETURN_COST_BASE_PATH` (반품 원가 베이스 파일 경로)
- `BOOTSTRAP_ADMIN_USERNAME` (기본: `ksh2932`)
- `BOOTSTRAP_ADMIN_PASSWORD` (기본: 빈 값)
- `BOOTSTRAP_ADMIN_DISPLAY_NAME` (기본: `관리자`)
- `AMOOD_HAPBAE_COST_BASE_PATH` (아무드합배 원가 베이스 경로)
- `COLLAB_ALLOW_ORIGINS` (기본: `*`, 쉼표 구분)
- `COLLAB_REQUEST_MAX_BYTES` (기본: `10485760`, 요청 첨부 최대 10MB)
- `COLLAB_SHARED_FILE_MAX_BYTES` (기본: `20971520`, 공유 파일 최대 20MB)
- `COLLAB_DB_PATH` (기본: `backend/collab_app.db`)
- `COLLAB_REQUEST_UPLOAD_BASE` (기본: `backend/uploads/collab_requests`)
- `COLLAB_SHARED_UPLOAD_BASE` (기본: `backend/uploads/collab_shared_files`)

예시:

```bash
cp .env.example .env
```

협업 서버 전용 예시:

```bash
copy .env.collab.example .env.collab
```

내부 업무 API는 로컬 서버를 유지하고, 협업 API만 외부로 분리하는 경우:

```env
VITE_LOCAL_API_BASE=http://192.168.0.10:8000
VITE_COLLAB_API_BASE=https://collab.example.com
COLLAB_ALLOW_ORIGINS=https://collab.example.com,https://admin.example.com
COLLAB_REQUEST_MAX_BYTES=10485760
COLLAB_SHARED_FILE_MAX_BYTES=20971520
COLLAB_DB_PATH=backend/collab_app.db
COLLAB_REQUEST_UPLOAD_BASE=backend/uploads/collab_requests
COLLAB_SHARED_UPLOAD_BASE=backend/uploads/collab_shared_files
```

## 배포 가이드

### Vercel 프론트

- 설정 파일: [vercel.json](/C:/Users/ksh29/OneDrive/Desktop/yusaek-main%20-%20복사본/yusaek-main/vercel.json)
- 제외 파일: [.vercelignore](/C:/Users/ksh29/OneDrive/Desktop/yusaek-main%20-%20복사본/yusaek-main/.vercelignore)
- Vercel 환경변수:
  - `VITE_LOCAL_API_BASE`
  - `VITE_COLLAB_API_BASE`

예시:

```env
VITE_LOCAL_API_BASE=http://192.168.0.10:8000
VITE_COLLAB_API_BASE=https://your-collab-api.onrender.com
```

### Render 백엔드

- 설정 파일: [render.yaml](/C:/Users/ksh29/OneDrive/Desktop/yusaek-main%20-%20복사본/yusaek-main/render.yaml)
- Render 전용 requirements: [backend/requirements-render.txt](/C:/Users/ksh29/OneDrive/Desktop/yusaek-main%20-%20복사본/yusaek-main/backend/requirements-render.txt)
- Python 버전 고정: [backend/runtime.txt](/C:/Users/ksh29/OneDrive/Desktop/yusaek-main%20-%20복사본/yusaek-main/backend/runtime.txt)
- 실행 앱: `backend/collab_app.py`

Render에서 필요한 값:

- `COLLAB_ALLOW_ORIGINS`를 실제 Vercel 도메인으로 설정
- `COLLAB_DB_PATH`
- `COLLAB_REQUEST_UPLOAD_BASE`
- `COLLAB_SHARED_UPLOAD_BASE`

예시:

```env
COLLAB_ALLOW_ORIGINS=https://your-collab.vercel.app
COLLAB_DB_PATH=/var/data/collab_app.db
COLLAB_REQUEST_UPLOAD_BASE=/var/data/collab_requests
COLLAB_SHARED_UPLOAD_BASE=/var/data/collab_shared_files
```

주의:

- Render에서 `COLLAB_DB_PATH`와 업로드 경로를 유지하려면 지속 저장소 경로를 사용해야 합니다.
- 장기적으로는 SQLite/로컬 업로드보다 Postgres + 외부 스토리지가 더 안전합니다.

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
