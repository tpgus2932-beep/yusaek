# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Frontend**
```bash
npm run dev        # dev server at http://localhost:5173
npm run build      # production build
npm run lint       # ESLint
npm run preview    # preview production build
```

**Backend (main)**
```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

**Backend (collab-only, for separate deployment)**
```bash
cd backend
uvicorn collab_app:app --reload --host 0.0.0.0 --port 8100
```

**Windows shortcut**
```bat
start_yusaek_collab.bat
```

## Architecture

### Overview
Internal operations dashboard for company YUSAEK. React + Vite frontend, FastAPI backend. No test suite.

### Frontend (`src/`)

**Routing** is handled manually in `App.jsx` — no React Router. Pathname-based special pages (`/attendance`, `/collab`, `/guidebook`, `/request-kimsungil`) render standalone components with no sidebar. All other pages are tab-based via `activeTab` state persisted in `localStorage`.

**API base URLs** (`src/lib/api.js`):
- `LOCAL_API_BASE` → `VITE_LOCAL_API_BASE` or `http://<hostname>:8000` — internal operations API
- `COLLAB_API_BASE` → `VITE_COLLAB_API_BASE` or same as `LOCAL_API_BASE` — collaboration/auth API (can be split to a separate server)

Auth token is stored in `localStorage` as `token` and sent as `Authorization: Bearer <token>`.

**Component structure** in `src/components/`:
- `Layout/` — Sidebar, Header, SettingsPage
- `Barcode/` — barcode scanning, product upload, returns, Amood/Jeju hapbae
- `Auth/` — login/register
- `Admin/` — user management, order management
- `Collab/` — external collaboration portal
- `CollabTools/` — internal collaboration menu
- `Attendance/`, `Guidebook/`, `NoyeKim/`, `ClientSchedule/`, `SMS/`, `AmoodSettlement/`, `DBManager/`, `Test/`, `Mobile/`

**User roles**: `admin`, `user`, `viewer`. `viewer` sees only the dashboard. Tab visibility is controlled by `hiddenTabs` (from `/settings/menu-visibility`) and overridden per role.

**EzadminSessionContext** (`src/lib/EzadminSessionContext.jsx`) wraps the main app to manage EZAdmin PHPSESSID session state shared across barcode components.

### Backend (`backend/`)

**`main.py`** is the monolithic entry point. It:
1. Initializes all SQLite tables (with `ALTER TABLE` column migrations for schema evolution)
2. Holds in-memory shared state (`BARCODE_STATES`, `RETURN_STATES`, `AMOOD_STATES`) — **server restarts lose scan state**
3. Registers all routers via factory functions

**Router pattern**: each domain module exports `build_*_router(get_current_user, ...)` — all dependencies are injected by `main.py`. This avoids circular imports since `main.py` owns DB connections and auth helpers.

**`collab_app.py`** is a lightweight server for external/cloud deployment. It imports helpers directly from `main.py` and only registers collaboration-relevant routers (auth, collab, SMS, attendance, guidebook, amood settlement).

**Database strategy** (`_get_db` vs `_get_shared_db`):
- `_get_db()` — private/local data (users, my todos, settings, order codes). Locally: SQLite. On Render: Turso if configured.
- `_get_shared_db()` — collaborative/shared data (requests, shared todos, client schedule, SMS, return states). Always Turso if `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set; otherwise SQLite.

**Turso HTTP client** (`_TursoHTTPConn`) is a custom HTTP-based Turso client (not the native libsql driver). Locally, SQLite is always preferred.

**In-memory barcode/amood/return state** is keyed by `username`. `SHARED_BARCODE_DATA` is broadcast to all users' states when a new Excel file is loaded. Each user has their own scan cursor (`current_invoice`).

### API Domains

| Module | Prefix | Purpose |
|--------|--------|---------|
| `auth_admin_routes` | `/auth`, `/admin` | JWT auth, user management |
| `barcode_routes` | `/barcode` | Barcode scanning, EZAdmin I200/IO30/IM00 |
| `amood_routes` | `/amood` | Amood Excel processing + scan |
| `amood_hapbae` | `/amood-hapbae` | Amood hapbae with cost base |
| `jeju_hapbae` | `/jeju-hapbae` | Jeju hapbae via Ably API |
| `returns_routes` | `/returns` | Return processing, Wonbe format |
| `return_shipping_routes` | `/return-shipping` | Return pickup via EZAdmin DS05/DS00 |
| `exchange_return_routes` | `/exchange-return` | Exchange/return via Ably API |
| `collab_routes` | `/requests`, `/shared-files`, `/todos`, `/company-credentials`, `/settings` | Collaboration features |
| `sms_routes` | `/sms` | SMS via Aligo API |
| `noye_kimsungil_routes` | `/noye-kimsungil` | Ably stock/delivery-type bulk update |
| `pastelco_routes` | `/pastelco` | Pastelco order fetch |
| `ably_minus_routes` | `/ably-minus` | Ably today-delivery option update |
| `ably_settlement_routes` | `/ably-settlement` | Ably settlement data |
| `amood_settlement_routes` | `/amood-settlement` | Amood settlement + cost management |
| `attendance_routes` | `/attendance` | PIN-based attendance |
| `guidebook_routes` | `/guidebook` | Image annotation guidebook |
| `accident_cargo_routes` | `/accident-cargo` | Accident cargo invoice tracking |
| `collaboration_tools_routes` | `/collaboration-tools` | Internal collab tool helpers |
| `misong_routes` | `/misong` | Misong (미송) processing |
| `wonbe_routes` | `/wonbe` | Wonbe format generation |
| `order_routes` | `/order` | Admin order code registration |

### External APIs

Key integrations:
- **Ably** (`https://api.a-bly.com`) — e-commerce orders, exchanges, returns, stock. Two origin modes: `my.a-bly.com` (read) vs `seller-admin.a-bly.com` (write).
- **Pastelco** (`https://api.pastelco.jp`) — Japanese marketplace orders.
- **EZAdmin** (`https://ga80.ezadmin.co.kr`) — inventory management via `POST /function.htm` with `PHPSESSID` cookie. Session stored in `app_settings` table under key `ezadmin_phpsessid`.

### Key Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `VITE_LOCAL_API_BASE` | `http://<hostname>:8000` | Frontend → backend URL |
| `VITE_COLLAB_API_BASE` | same as `LOCAL_API_BASE` | Frontend → collab server URL |
| `JWT_SECRET` | `dev-secret-change-me` | **Must change in production** |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | — | Enables cloud DB (required for Render) |
| `RETURN_COST_BASE_PATH` | — | Path to returns cost base Excel file |
| `AMOOD_HAPBAE_COST_BASE_PATH` | — | Path to Amood hapbae cost base Excel |
| `BOOTSTRAP_ADMIN_USERNAME` | `ksh2932` | Initial admin account |
| `COLLAB_ALLOW_ORIGINS` | `*` | CORS origins for collab server |

### Maintenance Notes

- Add new features to the appropriate domain router in `backend/api/`
- Excel/string processing logic goes in `backend/services/`, called from the router
- `main.py` handles only app init and router registration — no business logic directly in `main.py`
- Schema changes use `ALTER TABLE ... ADD COLUMN` pattern at startup (`_ensure_*_column` functions)
- `collab_app.py` imports from `main.py` — be careful not to introduce import-time side effects in `main.py` that break the collab-only server
