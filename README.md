# YUSAEK 관리자 대시보드 (Admin Dashboard)

React + Vite 기반 프런트엔드와 FastAPI 기반 백엔드를 포함한 관리자 대시보드 프로젝트입니다.  
바코드/반품/공유 파일 처리와 인증/관리자 기능을 제공하며, 로컬 파일 업로드와 SQLite 저장소를 사용합니다.

## ✨ 주요 기능

- **대시보드 개요**: 주요 지표/현황을 한눈에 확인
- **바코드 워크플로우**: 바코드 처리 및 결과 파일 다운로드
- **반품 처리**: 반품 데이터 업로드/가공 및 결과 추출
- **공유 파일 관리**: 공유 파일 업로드/다운로드
- **관리자/인증**: 사용자 인증 및 관리자 계정 관리
- **반응형 UI**: 데스크탑/태블릿/모바일 최적화

## 🧱 기술 스택

- **프런트엔드**: React, Vite, CSS Modules, Lucide-React
- **백엔드**: FastAPI, Uvicorn, SQLite
- **데이터 처리**: pandas, openpyxl, xlrd/xlwt, lxml
- **인증**: passlib(bcrypt), python-jose

## 🗂 프로젝트 구조

```text
.
├── backend/
│   ├── main.py                # FastAPI 앱
│   ├── requirements.txt       # 백엔드 의존성
│   ├── app.db                 # SQLite DB (로컬)
│   └── uploads/               # 업로드 파일 저장소
├── public/
├── src/
│   ├── components/
│   │   ├── Admin/
│   │   ├── Auth/
│   │   ├── Barcode/
│   │   ├── Dashboard/
│   │   └── Layout/
│   ├── App.jsx
│   └── index.css
├── package.json
└── vite.config.js
```

## ✅ 사전 준비

- Node.js (프런트엔드)
- Python 3.x (백엔드)

## 🚀 시작하기

### 1) 프런트엔드 실행

```bash
npm install
npm run dev
```

### 2) 백엔드 실행

```bash
python -m pip install -r backend/requirements.txt
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

프런트엔드는 브라우저에서 `http://localhost:5173`로 실행되고, 백엔드는 `http://127.0.0.1:8000`에서 동작합니다.  
프런트엔드는 백엔드 주소를 `http://<현재 호스트>:8000`으로 참조합니다.

## ⚙ 환경 변수

백엔드는 아래 환경 변수를 사용합니다. 필요 시 OS 환경 변수로 설정하세요.

- `RETURN_COST_BASE_PATH`: 반품 원가 베이스 파일 경로  
  기본값: `C:\Users\ksh29\OneDrive\Desktop\원베\원가베이스유.xlsx`
- `JWT_SECRET`: JWT 서명 키  
  기본값: `dev-secret-change-me`
- `BOOTSTRAP_ADMIN_USERNAME`: 초기 관리자 계정 아이디  
  기본값: `ksh2932`
- `BOOTSTRAP_ADMIN_PASSWORD`: 초기 관리자 계정 비밀번호  
  기본값: 빈 문자열
- `BOOTSTRAP_ADMIN_DISPLAY_NAME`: 초기 관리자 표시 이름  
  기본값: `관리자`

## 🧪 스크립트

```bash
npm run dev       # 개발 서버
npm run build     # 프로덕션 빌드
npm run preview   # 빌드 미리보기
npm run lint      # ESLint
```

## 📦 배포 가이드 (간단)

- 프런트엔드: `npm run build` 결과물은 `dist/`에 생성됩니다.
- 백엔드: 운영에서는 `--reload` 없이 Uvicorn/Gunicorn 등을 사용하세요.

## 🔒 보안 참고

- 기본 `JWT_SECRET`은 개발용입니다. 운영에서는 반드시 변경하세요.
- `BOOTSTRAP_ADMIN_PASSWORD`를 설정하지 않으면 초기 관리자 비밀번호가 비어 있습니다.

## 📄 라이선스

Copyright © 2026 YUSAEK. All rights reserved.
