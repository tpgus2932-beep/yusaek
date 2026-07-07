from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

KST = timezone(timedelta(hours=9))

ATTENDANCE_ADMIN_PIN_KEY = "attendance_admin_pin"


def build_attendance_router(*, get_db, get_setting, set_setting, hash_pin, verify_pin):
    router = APIRouter(prefix="/attendance", tags=["attendance"])

    # ── DB 초기화 ──────────────────────────────────────
    def _init():
        conn = get_db()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_members (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_records (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                member_name TEXT NOT NULL,
                type        TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                date        TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_att_rec_date ON attendance_records(date)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_fixed_rules (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id      INTEGER NOT NULL,
                weekday        INTEGER NOT NULL,
                start_time     TEXT NOT NULL,
                end_time       TEXT NOT NULL,
                effective_from TEXT NOT NULL,
                status         TEXT NOT NULL,
                created_at     TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_fixed_member ON attendance_schedule_fixed_rules(member_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_overrides (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id  INTEGER NOT NULL,
                date       TEXT NOT NULL,
                weekday    INTEGER NOT NULL,
                start_time TEXT NOT NULL,
                end_time   TEXT NOT NULL,
                status     TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(member_id, date)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_override_member ON attendance_schedule_overrides(member_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_schedule_memos (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id  INTEGER NOT NULL,
                date       TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(member_id, date)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sched_memo_member ON attendance_schedule_memos(member_id)"
        )
        conn.commit()
        conn.close()

    _init()

    # 시작 시 기본 PIN 저장 시도 — 실패해도 앱 구동은 계속
    try:
        if not get_setting(ATTENDANCE_ADMIN_PIN_KEY):
            set_setting(ATTENDANCE_ADMIN_PIN_KEY, hash_pin("1234"))
    except Exception:
        pass  # 아래 _check_pin 에서 지연 초기화로 처리

    def _check_pin(pin: str):
        """
        PIN 검증.
        DB에 값이 없으면 기본 PIN "1234" 로 지연 초기화한다.
        (배포 환경 첫 기동 시 startup 초기화가 실패했을 때 대비)
        """
        try:
            pin_hash = get_setting(ATTENDANCE_ADMIN_PIN_KEY)
        except Exception:
            pin_hash = None

        if not pin_hash:
            # DB에 PIN이 없으면 이번 요청을 계기로 "1234" 로 초기화
            if pin.strip() == "1234":
                try:
                    set_setting(ATTENDANCE_ADMIN_PIN_KEY, hash_pin("1234"))
                except Exception:
                    pass
                return          # 기본 PIN 허용
            raise HTTPException(status_code=403, detail="PIN이 올바르지 않습니다.")

        if not verify_pin(pin, pin_hash):
            raise HTTPException(status_code=403, detail="PIN이 올바르지 않습니다.")

    def _now_kst():
        return datetime.now(KST)

    # ── Pydantic 모델 ──────────────────────────────────
    class MemberCreate(BaseModel):
        name: str
        pin: str

    class MemberUpdate(BaseModel):
        name: str
        pin: str

    class MemberDelete(BaseModel):
        pin: str

    class RecordCreate(BaseModel):
        member_name: str
        type: str  # "출근" | "퇴근"

    class ManualRecordCreate(BaseModel):
        pin: str
        member_name: str
        type: str  # "출근" | "퇴근"
        date: str   # YYYY-MM-DD (KST)
        time: str   # HH:MM (KST)

    class RecordDelete(BaseModel):
        pin: str

    class PinVerify(BaseModel):
        pin: str

    class PinChange(BaseModel):
        old_pin: str
        new_pin: str

    class RecordUpdate(BaseModel):
        pin: str
        date: str   # YYYY-MM-DD (KST)
        time: str   # HH:MM (KST)

    # ── 직원 목록 (인증 불필요) ─────────────────────────
    @router.get("/members")
    def list_members():
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name FROM attendance_members ORDER BY name"
        ).fetchall()
        conn.close()
        return [{"id": r["id"], "name": r["name"]} for r in rows]

    # ── 직원 추가 (PIN 필요) ────────────────────────────
    @router.post("/members")
    def add_member(body: MemberCreate):
        _check_pin(body.pin)
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력하세요.")
        try:
            conn = get_db()
            conn.execute(
                "INSERT INTO attendance_members (name, created_at) VALUES (?, ?)",
                (name, _now_kst().isoformat()),
            )
            conn.commit()
            conn.close()
            return {"ok": True}
        except Exception as e:
            if "UNIQUE" in str(e).upper():
                raise HTTPException(status_code=409, detail="이미 존재하는 이름입니다.")
            raise HTTPException(status_code=500, detail=str(e))

    # ── 직원 삭제 (PIN 필요) ────────────────────────────
    @router.delete("/members/{member_id}")
    def delete_member(member_id: int, body: MemberDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute("DELETE FROM attendance_members WHERE id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_fixed_rules WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_overrides WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_schedule_memos WHERE member_id = ?", (member_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/members/{member_id}")
    def update_member(member_id: int, body: MemberUpdate):
        _check_pin(body.pin)
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력하세요.")

        conn = get_db()
        old = conn.execute(
            "SELECT name FROM attendance_members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not old:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")

        try:
            conn.execute(
                "UPDATE attendance_members SET name = ? WHERE id = ?",
                (name, member_id),
            )
            conn.execute(
                "UPDATE attendance_records SET member_name = ? WHERE member_name = ?",
                (name, old["name"]),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            if "UNIQUE" in str(e).upper():
                raise HTTPException(status_code=409, detail="이미 존재하는 이름입니다.")
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            conn.close()
        return {"ok": True}

    # ── 출퇴근 기록 (인증 불필요) ──────────────────────
    @router.post("/record")
    def record_attendance(body: RecordCreate):
        att_type = body.type.strip()
        if att_type not in ("출근", "퇴근"):
            raise HTTPException(status_code=400, detail="type은 출근 또는 퇴근이어야 합니다.")
        now_utc = datetime.now(timezone.utc)
        date_str = now_utc.astimezone(KST).strftime("%Y-%m-%d")
        conn = get_db()
        conn.execute(
            "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, ?, ?, ?)",
            (body.member_name.strip(), att_type, now_utc.isoformat(), date_str),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "timestamp": now_utc.isoformat()}

    @router.post("/records")
    def add_manual_record(body: ManualRecordCreate):
        _check_pin(body.pin)
        att_type = body.type.strip()
        if att_type not in ("출근", "퇴근"):
            raise HTTPException(status_code=400, detail="type은 출근 또는 퇴근이어야 합니다.")
        try:
            dt_kst = datetime.strptime(
                f"{body.date} {body.time}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
            dt_utc = dt_kst.astimezone(timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜/시간 형식이 올바르지 않습니다.")

        conn = get_db()
        conn.execute(
            "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, ?, ?, ?)",
            (body.member_name.strip(), att_type, dt_utc.isoformat(), body.date),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "timestamp": dt_utc.isoformat()}

    # ── 오늘 기록 (인증 불필요, 메인 페이지용) ─────────
    @router.get("/records/today")
    def get_today_records():
        date_str = datetime.now(timezone.utc).astimezone(KST).strftime("%Y-%m-%d")
        conn = get_db()
        rows = conn.execute(
            "SELECT id, member_name, type, timestamp, date "
            "FROM attendance_records WHERE date = ? ORDER BY timestamp DESC",
            (date_str,),
        ).fetchall()
        conn.close()
        return [
            {"id": r["id"], "name": r["member_name"], "type": r["type"],
             "timestamp": r["timestamp"], "date": r["date"]}
            for r in rows
        ]

    # ── 기록 조회 (PIN 필요, 관리자용) ─────────────────
    @router.get("/records")
    def get_records(
        pin: str = "",
        date: str = "",
        name: str = "",
        date_from: str = "",
        date_to: str = "",
    ):
        _check_pin(pin)
        conn = get_db()
        query = (
            "SELECT id, member_name, type, timestamp, date "
            "FROM attendance_records WHERE 1=1"
        )
        params: list = []
        if date:
            query += " AND date = ?"
            params.append(date)
        else:
            if date_from:
                query += " AND date >= ?"
                params.append(date_from)
            if date_to:
                query += " AND date <= ?"
                params.append(date_to)
        if name:
            query += " AND member_name = ?"
            params.append(name)
        query += " ORDER BY date DESC, member_name ASC, timestamp ASC"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return [
            {"id": r["id"], "name": r["member_name"], "type": r["type"],
             "timestamp": r["timestamp"], "date": r["date"]}
            for r in rows
        ]

    # ── 기록 시간 수정 (PIN 필요) ───────────────────────
    @router.patch("/records/{record_id}")
    def update_record(record_id: int, body: RecordUpdate):
        _check_pin(body.pin)
        try:
            dt_kst = datetime.strptime(
                f"{body.date} {body.time}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
            dt_utc = dt_kst.astimezone(timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜/시간 형식이 올바르지 않습니다.")
        conn = get_db()
        conn.execute(
            "UPDATE attendance_records SET timestamp = ?, date = ? WHERE id = ?",
            (dt_utc.isoformat(), body.date, record_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── 기록 삭제 (PIN 필요) ────────────────────────────
    @router.delete("/records/{record_id}")
    def delete_record(record_id: int, body: RecordDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute("DELETE FROM attendance_records WHERE id = ?", (record_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── PIN 확인 ────────────────────────────────────────
    @router.post("/verify-pin")
    def verify_pin_endpoint(body: PinVerify):
        _check_pin(body.pin)
        return {"ok": True}

    # ── PIN 변경 ────────────────────────────────────────
    @router.post("/change-pin")
    def change_pin(body: PinChange):
        _check_pin(body.old_pin)
        new_pin = body.new_pin.strip()
        if not new_pin:
            raise HTTPException(status_code=400, detail="새 PIN을 입력하세요.")
        set_setting(ATTENDANCE_ADMIN_PIN_KEY, hash_pin(new_pin))
        return {"ok": True}

    return router
