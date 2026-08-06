from datetime import datetime, timezone, timedelta
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

KST = timezone(timedelta(hours=9))

ATTENDANCE_ADMIN_PIN_KEY = "attendance_admin_pin"
ATTENDANCE_DEFAULT_SCHEDULE_KEY = "attendance_default_schedule_20260720_v1"
ATTENDANCE_DEFAULT_RECORDS_KEY = "attendance_default_records_20260720_v2"

# 2026-07-20 주차 근무표를 기준으로 한 기본 고정 스케줄.
# DB가 PC마다 따로 있어도 최초 실행 시 동일한 직원과 근무시간을 복원한다.
DEFAULT_ATTENDANCE_SCHEDULE = {
    "가희": [(3, "09:00", "14:00"), (4, "09:00", "14:00"), (5, "09:00", "13:30")],
    "미진": [(1, "09:00", "14:00"), (2, "09:00", "14:00"), (5, "09:00", "13:30")],
    "영아": [(1, "09:30", "14:00"), (2, "09:30", "14:00"), (3, "09:30", "14:00")],
    "은영": [(1, "09:00", "14:00"), (2, "09:00", "14:00"), (3, "09:00", "13:30")],
    "은진": [(1, "10:00", "15:00"), (3, "09:00", "14:00"), (5, "09:30", "14:00")],
    "이정": [(1, "09:00", "14:00"), (2, "09:00", "14:00"), (5, "09:30", "14:00")],
    "정란": [(2, "09:00", "14:00"), (3, "09:30", "14:00"), (4, "09:00", "14:00")],
    "정아": [(1, "10:00", "15:00"), (2, "10:00", "14:00"), (4, "10:00", "14:00")],
    "지선": [(1, "09:30", "14:30"), (2, "09:30", "14:00"), (4, "09:00", "14:00")],
    "혜주": [(4, "10:00", "14:00"), (5, "10:00", "14:00")],
}

# 사진에 기록된 2026-07-20~21 실제 출퇴근 시간.
DEFAULT_ATTENDANCE_RECORDS = [
    ("미진", "2026-07-20", "08:59", "13:58"),
    ("미진", "2026-07-21", "09:00", "12:49"),
    ("영아", "2026-07-20", "09:27", "13:58"),
    ("영아", "2026-07-21", "09:30", "12:50"),
    ("은영", "2026-07-20", "08:54", "13:58"),
    ("은영", "2026-07-21", "08:53", "12:48"),
    ("은진", "2026-07-20", "09:01", "13:58"),
    ("이정", "2026-07-20", "08:52", "13:59"),
    ("이정", "2026-07-21", "08:54", "12:49"),
    ("정란", "2026-07-21", "08:53", "12:49"),
    ("정아", "2026-07-20", "09:52", "13:58"),
    ("정아", "2026-07-21", "09:53", "12:49"),
    ("지선", "2026-07-20", "08:56", "13:59"),
    ("지선", "2026-07-21", "09:25", "12:49"),
]


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
                resident_registration_number TEXT NOT NULL DEFAULT '',
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
            CREATE TABLE IF NOT EXISTS attendance_daily_workers (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT NOT NULL,
                date                TEXT NOT NULL,
                start_time          TEXT NOT NULL,
                end_time            TEXT NOT NULL,
                check_in_record_id  INTEGER NOT NULL,
                check_out_record_id INTEGER NOT NULL,
                bank_name           TEXT NOT NULL DEFAULT '',
                account_holder      TEXT NOT NULL DEFAULT '',
                account_number      TEXT NOT NULL DEFAULT '',
                resident_registration_number TEXT NOT NULL DEFAULT '',
                payment_completed   INTEGER NOT NULL DEFAULT 0,
                hourly_rate        INTEGER NOT NULL,
                created_at          TEXT NOT NULL,
                UNIQUE(name, date)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_daily_workers_date ON attendance_daily_workers(date)"
        )
        daily_worker_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(attendance_daily_workers)").fetchall()
        }
        for column, ddl in (
            ("bank_name", "ALTER TABLE attendance_daily_workers ADD COLUMN bank_name TEXT NOT NULL DEFAULT ''"),
            ("account_holder", "ALTER TABLE attendance_daily_workers ADD COLUMN account_holder TEXT NOT NULL DEFAULT ''"),
            ("account_number", "ALTER TABLE attendance_daily_workers ADD COLUMN account_number TEXT NOT NULL DEFAULT ''"),
            ("resident_registration_number", "ALTER TABLE attendance_daily_workers ADD COLUMN resident_registration_number TEXT NOT NULL DEFAULT ''"),
            ("payment_completed", "ALTER TABLE attendance_daily_workers ADD COLUMN payment_completed INTEGER NOT NULL DEFAULT 0"),
            ("hourly_rate", "ALTER TABLE attendance_daily_workers ADD COLUMN hourly_rate INTEGER NOT NULL DEFAULT 10400"),
        ):
            if column not in daily_worker_cols:
                conn.execute(ddl)
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
        member_cols = [r["name"] for r in conn.execute("PRAGMA table_info(attendance_members)").fetchall()]
        if "include_in_schedule" not in member_cols:
            conn.execute(
                "ALTER TABLE attendance_members ADD COLUMN include_in_schedule INTEGER NOT NULL DEFAULT 1"
            )
        if "work_area" not in member_cols:
            conn.execute(
                "ALTER TABLE attendance_members ADD COLUMN work_area TEXT NOT NULL DEFAULT 'back'"
            )
        if "hourly_rate" not in member_cols:
            conn.execute(
                "ALTER TABLE attendance_members ADD COLUMN hourly_rate INTEGER NOT NULL DEFAULT 0"
            )
        if "pay_type" not in member_cols:
            conn.execute(
                "ALTER TABLE attendance_members ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'hourly'"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_member_hourly_rate_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id INTEGER NOT NULL,
                hourly_rate INTEGER NOT NULL,
                effective_date TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_member_hourly_rate_history_member_date "
            "ON attendance_member_hourly_rate_history(member_id, effective_date)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_piece_work_records (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id   INTEGER NOT NULL,
                work_date   TEXT NOT NULL,
                job_count   INTEGER NOT NULL,
                unit_amount INTEGER NOT NULL,
                created_at  TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_piece_work_member_date "
            "ON attendance_piece_work_records(member_id, work_date)"
        )
        history_bootstrap_now = datetime.now(timezone.utc).astimezone(KST)
        conn.execute(
            "INSERT INTO attendance_member_hourly_rate_history "
            "(member_id, hourly_rate, effective_date, created_at) "
            "SELECT m.id, m.hourly_rate, ?, ? FROM attendance_members m "
            "WHERE hourly_rate > 0 AND NOT EXISTS ("
            "SELECT 1 FROM attendance_member_hourly_rate_history h WHERE h.member_id = m.id)",
            (history_bootstrap_now.strftime("%Y-%m-%d"), history_bootstrap_now.isoformat()),
        )
        for column, ddl in (
            ("bank_name", "ALTER TABLE attendance_members ADD COLUMN bank_name TEXT NOT NULL DEFAULT ''"),
            ("account_holder", "ALTER TABLE attendance_members ADD COLUMN account_holder TEXT NOT NULL DEFAULT ''"),
            ("account_number", "ALTER TABLE attendance_members ADD COLUMN account_number TEXT NOT NULL DEFAULT ''"),
            ("resident_registration_number", "ALTER TABLE attendance_members ADD COLUMN resident_registration_number TEXT NOT NULL DEFAULT ''"),
        ):
            if column not in member_cols:
                conn.execute(ddl)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_fixed_worker_payments (
                member_id          INTEGER NOT NULL,
                year               INTEGER NOT NULL,
                month              INTEGER NOT NULL,
                payment_completed  INTEGER NOT NULL DEFAULT 0,
                updated_at         TEXT NOT NULL,
                PRIMARY KEY(member_id, year, month)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_payment_requests (
                id                           INTEGER PRIMARY KEY AUTOINCREMENT,
                date                         TEXT NOT NULL,
                bank_name                    TEXT NOT NULL,
                account_holder               TEXT NOT NULL,
                account_number               TEXT NOT NULL,
                amount                       INTEGER NOT NULL,
                content                      TEXT NOT NULL,
                resident_registration_number TEXT NOT NULL DEFAULT '',
                payment_completed            INTEGER NOT NULL DEFAULT 0,
                created_at                   TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_payment_requests_date ON attendance_payment_requests(date)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_studio_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                studio_name TEXT NOT NULL,
                usage_time TEXT NOT NULL,
                amount INTEGER NOT NULL,
                bank_name TEXT NOT NULL,
                account_number TEXT NOT NULL,
                account_holder TEXT NOT NULL,
                model_name TEXT NOT NULL,
                model_payment INTEGER NOT NULL,
                shoot_date TEXT NOT NULL,
                payment_completed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_studio_payments_date ON attendance_studio_payments(shoot_date)"
        )
        studio_payment_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(attendance_studio_payments)").fetchall()
        }
        if "vat_amount" not in studio_payment_cols:
            conn.execute(
                "ALTER TABLE attendance_studio_payments ADD COLUMN vat_amount INTEGER NOT NULL DEFAULT 0"
            )
        if "model_member_id" not in studio_payment_cols:
            conn.execute(
                "ALTER TABLE attendance_studio_payments ADD COLUMN model_member_id INTEGER"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_member_fixed_allowances (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id  INTEGER NOT NULL,
                name       TEXT NOT NULL,
                amount     INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_member_fixed_allowances_member "
            "ON attendance_member_fixed_allowances(member_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_checkin_alerts (
                member_name TEXT NOT NULL,
                date        TEXT NOT NULL,
                request_id  INTEGER,
                created_at  TEXT NOT NULL,
                PRIMARY KEY(member_name, date)
            )
            """
        )
        conn.commit()
        conn.close()

    _init()

    # Git에는 로컬 DB가 포함되지 않으므로, 새 PC/새 DB에도 기본 근무표를 한 번만 구성한다.
    try:
        if get_setting(ATTENDANCE_DEFAULT_SCHEDULE_KEY) != "done":
            conn = get_db()
            now = datetime.now(KST).isoformat()
            for name, shifts in DEFAULT_ATTENDANCE_SCHEDULE.items():
                conn.execute(
                    "INSERT OR IGNORE INTO attendance_members (name, created_at, include_in_schedule) "
                    "VALUES (?, ?, 1)",
                    (name, now),
                )
                member = conn.execute(
                    "SELECT id FROM attendance_members WHERE name = ?",
                    (name,),
                ).fetchone()
                if not member:
                    continue
                existing_count = conn.execute(
                    "SELECT COUNT(*) AS count FROM attendance_schedule_fixed_rules WHERE member_id = ?",
                    (member["id"],),
                ).fetchone()["count"]
                if existing_count:
                    continue
                for weekday, start_time, end_time in shifts:
                    conn.execute(
                        "INSERT INTO attendance_schedule_fixed_rules "
                        "(member_id, weekday, start_time, end_time, effective_from, status, created_at) "
                        "VALUES (?, ?, ?, ?, ?, 'scheduled', ?)",
                        (member["id"], weekday, start_time, end_time, "2026-07-20", now),
                    )
            conn.commit()
            conn.close()
            set_setting(ATTENDANCE_DEFAULT_SCHEDULE_KEY, "done")
    except Exception:
        # 원격 DB가 일시적으로 unavailable이어도 앱 시작 자체는 막지 않는다.
        try:
            conn.close()
        except Exception:
            pass

    # 사진으로 확인된 실제 출퇴근 기록도 새 PC/새 DB에 한 번만 복원한다.
    try:
        if get_setting(ATTENDANCE_DEFAULT_RECORDS_KEY) != "done":
            conn = get_db()
            for name, date_str, check_in, check_out in DEFAULT_ATTENDANCE_RECORDS:
                for record_type, time_str in (("출근", check_in), ("퇴근", check_out)):
                    exists = conn.execute(
                        "SELECT 1 FROM attendance_records "
                        "WHERE member_name = ? AND date = ? AND type = ? LIMIT 1",
                        (name, date_str, record_type),
                    ).fetchone()
                    if exists:
                        continue
                    dt_kst = datetime.strptime(
                        f"{date_str} {time_str}", "%Y-%m-%d %H:%M"
                    ).replace(tzinfo=KST)
                    conn.execute(
                        "INSERT INTO attendance_records (member_name, type, timestamp, date) "
                        "VALUES (?, ?, ?, ?)",
                        (name, record_type, dt_kst.astimezone(timezone.utc).isoformat(), date_str),
                    )
            conn.commit()
            conn.close()
            set_setting(ATTENDANCE_DEFAULT_RECORDS_KEY, "done")
    except Exception:
        try:
            conn.close()
        except Exception:
            pass

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

    def _scheduled_start_for(conn, member_name: str, date_str: str) -> str | None:
        member = conn.execute(
            "SELECT id FROM attendance_members WHERE name = ?", (member_name,)
        ).fetchone()
        if not member:
            return None
        override = conn.execute(
            "SELECT start_time, status FROM attendance_schedule_overrides "
            "WHERE member_id = ? AND date = ? ORDER BY id DESC LIMIT 1",
            (member["id"], date_str),
        ).fetchone()
        if override:
            return override["start_time"] if override["status"] == "scheduled" else None
        weekday = datetime.strptime(date_str, "%Y-%m-%d").isoweekday()
        fixed = conn.execute(
            "SELECT start_time, status FROM attendance_schedule_fixed_rules "
            "WHERE member_id = ? AND weekday = ? AND effective_from <= ? "
            "ORDER BY effective_from DESC, id DESC LIMIT 1",
            (member["id"], weekday, date_str),
        ).fetchone()
        return fixed["start_time"] if fixed and fixed["status"] == "scheduled" else None

    def _round_kst_to_half_hour(dt_kst: datetime) -> datetime:
        rounded_minutes = ((dt_kst.hour * 60 + dt_kst.minute + 15) // 30) * 30
        day_offset, minute_of_day = divmod(rounded_minutes, 24 * 60)
        return dt_kst.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
            days=day_offset, minutes=minute_of_day
        )

    def _create_checkin_alert_once(
        conn, member_name: str, date_str: str, actual_kst: datetime
    ) -> None:
        exists = conn.execute(
            "SELECT 1 FROM attendance_checkin_alerts WHERE member_name = ? AND date = ?",
            (member_name, date_str),
        ).fetchone()
        if exists:
            return
        try:
            assignee = conn.execute(
                "SELECT username, display_name FROM users WHERE display_name = ? LIMIT 1",
                ("김승일",),
            ).fetchone()
            if not assignee:
                return
            text = (
                f"{member_name} / {actual_kst.strftime('%H시 %M분')} 출근 "
                "출근 시간 확인필요"
            )
            created_at = datetime.now(timezone.utc).isoformat()
            cursor = conn.execute(
                "INSERT INTO requests "
                "(requester_username, requester_display, assignee_username, assignee_display, "
                "text, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
                (
                    "attendance_system",
                    "출퇴근 자동알림",
                    assignee["username"],
                    (assignee["display_name"] or "").strip() or "김승일",
                    text,
                    created_at,
                ),
            )
            conn.execute(
                "INSERT INTO attendance_checkin_alerts "
                "(member_name, date, request_id, created_at) VALUES (?, ?, ?, ?)",
                (member_name, date_str, cursor.lastrowid, created_at),
            )
            conn.commit()
        except Exception:
            conn.rollback()

    def _check_checkin_exception(
        conn, member_name: str, date_str: str, timestamp: str
    ) -> tuple[bool, str | None, str | None]:
        scheduled_start = _scheduled_start_for(conn, member_name, date_str)
        if not scheduled_start:
            return False, None, None
        actual_in = datetime.fromisoformat(timestamp).astimezone(KST)
        hour, minute = map(int, scheduled_start.split(":"))
        scheduled_dt = actual_in.replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        is_exception = abs((actual_in - scheduled_dt).total_seconds()) > 15 * 60
        if is_exception:
            _create_checkin_alert_once(conn, member_name, date_str, actual_in)
            return True, scheduled_start, None
        return False, scheduled_start, scheduled_dt.astimezone(timezone.utc).isoformat()

    def _normalize_attendance_rows(conn, rows) -> list[dict]:
        grouped: dict[tuple[str, str], list] = {}
        for row in rows:
            grouped.setdefault((row["member_name"], row["date"]), []).append(row)

        result = []
        for (member_name, date_str), day_rows in grouped.items():
            scheduled_start = _scheduled_start_for(conn, member_name, date_str)
            check_in = next((row for row in day_rows if row["type"] == "출근"), None)
            check_in_exception = False
            normalized_check_in = None
            if check_in:
                check_in_exception, scheduled_start, normalized_check_in = (
                    _check_checkin_exception(
                        conn, member_name, date_str, check_in["timestamp"]
                    )
                )

            for row in day_rows:
                normalized_timestamp = row["timestamp"]
                if row["type"] == "출근" and normalized_check_in:
                    normalized_timestamp = normalized_check_in
                elif row["type"] == "퇴근":
                    actual_out = datetime.fromisoformat(row["timestamp"]).astimezone(KST)
                    normalized_timestamp = _round_kst_to_half_hour(
                        actual_out
                    ).astimezone(timezone.utc).isoformat()
                result.append(
                    {
                        "id": row["id"],
                        "name": row["member_name"],
                        "type": row["type"],
                        "timestamp": row["timestamp"],
                        "date": row["date"],
                        "normalizedTimestamp": normalized_timestamp,
                        # 15분 초과는 관리자 확인 알림으로만 처리한다.
                        # 실제 출퇴근 기록은 고정 여부와 관계없이 항상 급여 계산에 사용한다.
                        "payrollEligible": True,
                        "checkInException": check_in_exception,
                        "scheduledStartTime": scheduled_start,
                    }
                )
        return result

    # ── Pydantic 모델 ──────────────────────────────────
    class MemberCreate(BaseModel):
        name: str
        pin: str
        workArea: str = "back"

    class MemberUpdate(BaseModel):
        name: str
        pin: str
        hourlyRate: int | None = None

    class MemberDelete(BaseModel):
        pin: str

    class MemberScheduleVisibility(BaseModel):
        pin: str
        includeInSchedule: bool

    class MemberWorkAreaUpdate(BaseModel):
        pin: str
        workArea: str

    class MemberPayTypeUpdate(BaseModel):
        pin: str
        payType: str

    class MemberAccountUpdate(BaseModel):
        pin: str
        bankName: str
        accountHolder: str
        accountNumber: str
        residentRegistrationNumber: str = ""

    class FixedWorkerPaymentUpdate(BaseModel):
        pin: str
        year: int
        month: int
        completed: bool

    class FixedAllowanceItem(BaseModel):
        name: str
        amount: int

    class FixedAllowancesUpdate(BaseModel):
        pin: str
        allowances: list[FixedAllowanceItem]

    class PieceWorkCreate(BaseModel):
        pin: str
        memberId: int
        date: str
        jobCount: int
        unitAmount: int

    class PieceWorkUpdate(PieceWorkCreate):
        pass

    class PieceWorkDelete(BaseModel):
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

    class ManualRecordPairCreate(BaseModel):
        pin: str
        member_name: str
        date: str
        startTime: str
        endTime: str

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

    class DailyWorkerCreate(BaseModel):
        pin: str
        name: str
        date: str
        startTime: str
        endTime: str
        hourlyRate: int
        bankName: str = ""
        accountHolder: str = ""
        accountNumber: str = ""
        residentRegistrationNumber: str = ""

    class DailyWorkerAccountUpdate(BaseModel):
        pin: str
        bankName: str = ""
        accountHolder: str = ""
        accountNumber: str = ""

    class DailyWorkerResidentNumberUpdate(BaseModel):
        pin: str
        residentRegistrationNumber: str = ""

    class DailyWorkerDelete(BaseModel):
        pin: str

    class DailyWorkerPaymentUpdate(BaseModel):
        pin: str
        completed: bool

    class PaymentRequestCreate(BaseModel):
        pin: str
        date: str
        bankName: str
        accountHolder: str
        accountNumber: str
        amount: int
        content: str
        residentRegistrationNumber: str = ""

    class PaymentRequestUpdate(PaymentRequestCreate):
        pass

    class PaymentRequestPaymentUpdate(BaseModel):
        pin: str
        completed: bool

    class PaymentRequestDelete(BaseModel):
        pin: str

    class StudioPaymentCreate(BaseModel):
        pin: str
        studioName: str
        usageTime: str
        amount: int
        vatAmount: int = 0
        bankName: str
        accountNumber: str
        accountHolder: str
        modelMemberId: int
        shootDate: str

    class StudioPaymentUpdate(StudioPaymentCreate):
        pass

    # ── 직원 목록 (인증 불필요) ─────────────────────────
    @router.get("/members")
    def list_members():
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name, include_in_schedule, work_area, hourly_rate, pay_type "
            "FROM attendance_members ORDER BY name"
        ).fetchall()
        history_rows = conn.execute(
            "SELECT id, member_id, hourly_rate, effective_date, created_at "
            "FROM attendance_member_hourly_rate_history ORDER BY effective_date, id"
        ).fetchall()
        histories = {}
        for history in history_rows:
            histories.setdefault(history["member_id"], []).append({
                "id": history["id"],
                "hourlyRate": history["hourly_rate"] if history["hourly_rate"] > 0 else None,
                "effectiveDate": history["effective_date"],
                "changedAt": history["created_at"],
            })
        result = [
            {
                "id": r["id"],
                "name": r["name"],
                "includeInSchedule": bool(r["include_in_schedule"]),
                "workArea": r["work_area"] if r["work_area"] in ("back", "front") else "back",
                "hourlyRate": r["hourly_rate"] if r["hourly_rate"] > 0 else None,
                "payType": r["pay_type"] if r["pay_type"] in ("hourly", "piece", "studio") else "hourly",
                "hourlyRateHistory": histories.get(r["id"], []),
            }
            for r in rows
        ]
        conn.close()
        return result

    @router.get("/members/accounts")
    def list_member_accounts(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        rows = conn.execute(
            "SELECT id, bank_name, account_holder, account_number, resident_registration_number "
            "FROM attendance_members ORDER BY name"
        ).fetchall()
        conn.close()
        return [
            {
                "id": row["id"],
                "bankName": row["bank_name"],
                "accountHolder": row["account_holder"],
                "accountNumber": row["account_number"],
                "residentRegistrationNumber": row["resident_registration_number"],
            }
            for row in rows
        ]

    @router.patch("/members/{member_id}/account")
    def update_member_account(member_id: int, body: MemberAccountUpdate):
        _check_pin(body.pin)
        bank_name = body.bankName.strip()
        account_holder = body.accountHolder.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        resident_number = re.sub(r"[^0-9]", "", body.residentRegistrationNumber)
        if not all((bank_name, account_holder, account_number)):
            raise HTTPException(status_code=400, detail="은행, 예금주, 계좌번호를 모두 입력하세요.")
        if resident_number and len(resident_number) != 13:
            raise HTTPException(status_code=400, detail="주민등록번호 13자리를 정확히 입력하세요.")
        conn = get_db()
        row = conn.execute("SELECT id FROM attendance_members WHERE id = ?", (member_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_members SET bank_name = ?, account_holder = ?, account_number = ?, "
            "resident_registration_number = ? WHERE id = ?",
            (bank_name, account_holder, account_number, resident_number, member_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/fixed-worker-payments")
    def list_fixed_worker_payments(year: int, month: int, pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        rows = conn.execute(
            "SELECT member_id, payment_completed FROM attendance_fixed_worker_payments "
            "WHERE year = ? AND month = ?",
            (year, month),
        ).fetchall()
        conn.close()
        return {str(row["member_id"]): bool(row["payment_completed"]) for row in rows}

    @router.get("/members/fixed-allowances")
    def list_member_fixed_allowances(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        rows = conn.execute(
            "SELECT id, member_id, name, amount FROM attendance_member_fixed_allowances "
            "ORDER BY member_id, id"
        ).fetchall()
        conn.close()
        result = {}
        for row in rows:
            result.setdefault(str(row["member_id"]), []).append({
                "id": row["id"],
                "name": row["name"],
                "amount": row["amount"],
                "fixed": True,
            })
        return result

    @router.put("/members/{member_id}/fixed-allowances")
    def save_member_fixed_allowances(member_id: int, body: FixedAllowancesUpdate):
        _check_pin(body.pin)
        normalized = []
        for allowance in body.allowances:
            name = allowance.name.strip()
            if not name or allowance.amount <= 0:
                raise HTTPException(status_code=400, detail="추가수당 내용과 금액을 확인하세요.")
            normalized.append((name, allowance.amount))
        conn = get_db()
        member = conn.execute(
            "SELECT id FROM attendance_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not member:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        conn.execute(
            "DELETE FROM attendance_member_fixed_allowances WHERE member_id = ?", (member_id,)
        )
        now = _now_kst().isoformat()
        conn.executemany(
            "INSERT INTO attendance_member_fixed_allowances (member_id, name, amount, created_at) "
            "VALUES (?, ?, ?, ?)",
            [(member_id, name, amount, now) for name, amount in normalized],
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/fixed-worker-payments/{member_id}")
    def update_fixed_worker_payment(member_id: int, body: FixedWorkerPaymentUpdate):
        _check_pin(body.pin)
        if body.month < 1 or body.month > 12:
            raise HTTPException(status_code=400, detail="월 형식이 올바르지 않습니다.")
        conn = get_db()
        member = conn.execute("SELECT id FROM attendance_members WHERE id = ?", (member_id,)).fetchone()
        if not member:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        conn.execute(
            "INSERT INTO attendance_fixed_worker_payments "
            "(member_id, year, month, payment_completed, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(member_id, year, month) DO UPDATE SET "
            "payment_completed = excluded.payment_completed, updated_at = excluded.updated_at",
            (member_id, body.year, body.month, 1 if body.completed else 0, _now_kst().isoformat()),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "paymentCompleted": body.completed}

    # ── 건당 알바 ──────────────────────────────────────
    def _piece_work_row_to_dict(row):
        return {
            "id": row["id"],
            "memberId": row["member_id"],
            "name": row["member_name"],
            "workArea": row["work_area"] if row["work_area"] in ("back", "front") else "back",
            "date": row["work_date"],
            "jobCount": row["job_count"],
            "unitAmount": row["unit_amount"],
            "totalAmount": row["job_count"] * row["unit_amount"],
        }

    def _validate_piece_work(conn, member_id: int, date: str, job_count: int, unit_amount: int):
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="근무날짜 형식이 올바르지 않습니다.")
        if job_count <= 0 or unit_amount <= 0:
            raise HTTPException(status_code=400, detail="건수와 건당금액은 1 이상 입력하세요.")
        member = conn.execute(
            "SELECT id, pay_type FROM attendance_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        if member["pay_type"] != "piece":
            raise HTTPException(status_code=400, detail="급여방식이 건당인 직원만 등록할 수 있습니다.")

    @router.get("/piece-work-records")
    def list_piece_work_records(
        pin: str = "", date_from: str = "", date_to: str = "", member_id: int | None = None
    ):
        _check_pin(pin)
        if date_from:
            try:
                datetime.strptime(date_from, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="조회 시작일 형식이 올바르지 않습니다.")
        if date_to:
            try:
                datetime.strptime(date_to, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="조회 종료일 형식이 올바르지 않습니다.")
        if date_from and date_to and date_from > date_to:
            raise HTTPException(status_code=400, detail="조회 시작일은 종료일보다 늦을 수 없습니다.")
        conn = get_db()
        query = (
            "SELECT p.id, p.member_id, p.work_date, p.job_count, p.unit_amount, "
            "m.name AS member_name, m.work_area FROM attendance_piece_work_records p "
            "JOIN attendance_members m ON m.id = p.member_id WHERE 1=1"
        )
        params = []
        if date_from:
            query += " AND p.work_date >= ?"
            params.append(date_from)
        if date_to:
            query += " AND p.work_date <= ?"
            params.append(date_to)
        if member_id is not None:
            query += " AND p.member_id = ?"
            params.append(member_id)
        query += " ORDER BY p.work_date DESC, p.id DESC"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return [_piece_work_row_to_dict(row) for row in rows]

    @router.post("/piece-work-records")
    def add_piece_work_record(body: PieceWorkCreate):
        _check_pin(body.pin)
        conn = get_db()
        try:
            _validate_piece_work(conn, body.memberId, body.date, body.jobCount, body.unitAmount)
            cursor = conn.execute(
                "INSERT INTO attendance_piece_work_records "
                "(member_id, work_date, job_count, unit_amount, created_at) VALUES (?, ?, ?, ?, ?)",
                (body.memberId, body.date, body.jobCount, body.unitAmount, _now_kst().isoformat()),
            )
            conn.commit()
            row = conn.execute(
                "SELECT p.id, p.member_id, p.work_date, p.job_count, p.unit_amount, "
                "m.name AS member_name, m.work_area FROM attendance_piece_work_records p "
                "JOIN attendance_members m ON m.id = p.member_id WHERE p.id = ?",
                (cursor.lastrowid,),
            ).fetchone()
            return _piece_work_row_to_dict(row)
        except HTTPException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @router.patch("/piece-work-records/{record_id}")
    def update_piece_work_record(record_id: int, body: PieceWorkUpdate):
        _check_pin(body.pin)
        conn = get_db()
        try:
            exists = conn.execute(
                "SELECT id FROM attendance_piece_work_records WHERE id = ?", (record_id,)
            ).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="건당 알바 기록을 찾을 수 없습니다.")
            _validate_piece_work(conn, body.memberId, body.date, body.jobCount, body.unitAmount)
            conn.execute(
                "UPDATE attendance_piece_work_records SET member_id = ?, work_date = ?, "
                "job_count = ?, unit_amount = ? WHERE id = ?",
                (body.memberId, body.date, body.jobCount, body.unitAmount, record_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT p.id, p.member_id, p.work_date, p.job_count, p.unit_amount, "
                "m.name AS member_name, m.work_area FROM attendance_piece_work_records p "
                "JOIN attendance_members m ON m.id = p.member_id WHERE p.id = ?",
                (record_id,),
            ).fetchone()
            return _piece_work_row_to_dict(row)
        except HTTPException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @router.delete("/piece-work-records/{record_id}")
    def delete_piece_work_record(record_id: int, body: PieceWorkDelete):
        _check_pin(body.pin)
        conn = get_db()
        cursor = conn.execute("DELETE FROM attendance_piece_work_records WHERE id = ?", (record_id,))
        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="건당 알바 기록을 찾을 수 없습니다.")
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── 근무표 포함 여부 변경 (PIN 필요) ─────────────────
    @router.patch("/members/{member_id}/schedule-visibility")
    def set_member_schedule_visibility(member_id: int, body: MemberScheduleVisibility):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute(
            "UPDATE attendance_members SET include_in_schedule = ? WHERE id = ?",
            (1 if body.includeInSchedule else 0, member_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── 직원 백/프론트 표시 구분 변경 (PIN 필요) ─────────
    @router.patch("/members/{member_id}/work-area")
    def set_member_work_area(member_id: int, body: MemberWorkAreaUpdate):
        _check_pin(body.pin)
        work_area = body.workArea.strip().lower()
        if work_area not in ("back", "front"):
            raise HTTPException(status_code=400, detail="직원 구분이 올바르지 않습니다.")
        conn = get_db()
        member = conn.execute(
            "SELECT id FROM attendance_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not member:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_members SET work_area = ? WHERE id = ?",
            (work_area, member_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "workArea": work_area}

    @router.patch("/members/{member_id}/pay-type")
    def set_member_pay_type(member_id: int, body: MemberPayTypeUpdate):
        _check_pin(body.pin)
        pay_type = body.payType.strip().lower()
        if pay_type not in ("hourly", "piece", "studio"):
            raise HTTPException(status_code=400, detail="급여방식이 올바르지 않습니다.")
        conn = get_db()
        member = conn.execute(
            "SELECT id FROM attendance_members WHERE id = ?", (member_id,)
        ).fetchone()
        if not member:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_members SET pay_type = ? WHERE id = ?", (pay_type, member_id)
        )
        conn.commit()
        conn.close()
        return {"ok": True, "payType": pay_type}

    # ── 직원 추가 (PIN 필요) ────────────────────────────
    @router.post("/members")
    def add_member(body: MemberCreate):
        _check_pin(body.pin)
        name = body.name.strip()
        work_area = body.workArea.strip().lower()
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력하세요.")
        if work_area not in ("back", "front"):
            raise HTTPException(status_code=400, detail="직원 구분이 올바르지 않습니다.")
        try:
            conn = get_db()
            conn.execute(
                "INSERT INTO attendance_members (name, created_at, work_area) VALUES (?, ?, ?)",
                (name, _now_kst().isoformat(), work_area),
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
        conn.execute("DELETE FROM attendance_fixed_worker_payments WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM attendance_piece_work_records WHERE member_id = ?", (member_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/members/{member_id}")
    def update_member(member_id: int, body: MemberUpdate):
        _check_pin(body.pin)
        name = body.name.strip()
        hourly_rate = body.hourlyRate or 0
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력하세요.")
        if hourly_rate < 0:
            raise HTTPException(status_code=400, detail="시급은 0원 이상으로 입력하세요.")

        conn = get_db()
        old = conn.execute(
            "SELECT name, hourly_rate FROM attendance_members WHERE id = ?",
            (member_id,),
        ).fetchone()
        if not old:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")

        try:
            conn.execute(
                "UPDATE attendance_members SET name = ?, hourly_rate = ? WHERE id = ?",
                (name, hourly_rate, member_id),
            )
            if hourly_rate != old["hourly_rate"]:
                now = _now_kst()
                conn.execute(
                    "INSERT INTO attendance_member_hourly_rate_history "
                    "(member_id, hourly_rate, effective_date, created_at) VALUES (?, ?, ?, ?)",
                    (member_id, hourly_rate, now.strftime("%Y-%m-%d"), now.isoformat()),
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
        if att_type == "출근":
            _check_checkin_exception(
                conn, body.member_name.strip(), date_str, now_utc.isoformat()
            )
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
        if att_type == "출근":
            _check_checkin_exception(
                conn, body.member_name.strip(), body.date, dt_utc.isoformat()
            )
        conn.close()
        return {"ok": True, "timestamp": dt_utc.isoformat()}

    @router.post("/records/pair")
    def add_manual_record_pair(body: ManualRecordPairCreate):
        _check_pin(body.pin)
        member_name = body.member_name.strip()
        if not member_name:
            raise HTTPException(status_code=400, detail="직원을 선택하세요.")
        try:
            check_in_kst = datetime.strptime(
                f"{body.date} {body.startTime}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
            check_out_kst = datetime.strptime(
                f"{body.date} {body.endTime}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜/시간 형식이 올바르지 않습니다.")
        if check_out_kst <= check_in_kst:
            raise HTTPException(status_code=400, detail="퇴근시간은 출근시간보다 늦어야 합니다.")

        conn = get_db()
        member = conn.execute(
            "SELECT id FROM attendance_members WHERE name = ?", (member_name,)
        ).fetchone()
        if not member:
            conn.close()
            raise HTTPException(status_code=404, detail="직원을 찾을 수 없습니다.")
        existing = conn.execute(
            "SELECT type FROM attendance_records "
            "WHERE member_name = ? AND date = ? AND type IN ('출근', '퇴근')",
            (member_name, body.date),
        ).fetchall()
        if existing:
            conn.close()
            existing_types = ", ".join(sorted({row["type"] for row in existing}))
            raise HTTPException(
                status_code=409,
                detail=f"해당 날짜에 이미 {existing_types} 기록이 있습니다. 기존 기록에서 수정하세요.",
            )

        check_in_utc = check_in_kst.astimezone(timezone.utc)
        check_out_utc = check_out_kst.astimezone(timezone.utc)
        try:
            conn.execute(
                "INSERT INTO attendance_records (member_name, type, timestamp, date) "
                "VALUES (?, '출근', ?, ?)",
                (member_name, check_in_utc.isoformat(), body.date),
            )
            conn.execute(
                "INSERT INTO attendance_records (member_name, type, timestamp, date) "
                "VALUES (?, '퇴근', ?, ?)",
                (member_name, check_out_utc.isoformat(), body.date),
            )
            conn.commit()
            _check_checkin_exception(conn, member_name, body.date, check_in_utc.isoformat())
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return {"ok": True}

    # ── 일일 알바 ──────────────────────────────────────
    def _daily_worker_row_to_dict(row):
        return {
            "id": row["id"],
            "name": row["name"],
            "date": row["date"],
            "startTime": row["start_time"],
            "endTime": row["end_time"],
            "checkInTimestamp": row["check_in_timestamp"],
            "checkOutTimestamp": row["check_out_timestamp"],
            "bankName": row["bank_name"],
            "accountHolder": row["account_holder"],
            "accountNumber": row["account_number"],
            "residentRegistrationNumber": row["resident_registration_number"],
            "paymentCompleted": bool(row["payment_completed"]),
            "hourlyRate": row["hourly_rate"],
        }

    @router.get("/daily-workers")
    def list_daily_workers(pin: str = "", date_from: str = "", date_to: str = ""):
        _check_pin(pin)
        conn = get_db()
        query = (
            "SELECT d.id, d.name, d.date, d.start_time, d.end_time, "
            "d.bank_name, d.account_holder, d.account_number, "
            "d.resident_registration_number, d.payment_completed, d.hourly_rate, "
            "i.timestamp AS check_in_timestamp, o.timestamp AS check_out_timestamp "
            "FROM attendance_daily_workers d "
            "LEFT JOIN attendance_records i ON i.id = d.check_in_record_id "
            "LEFT JOIN attendance_records o ON o.id = d.check_out_record_id WHERE 1=1"
        )
        params = []
        if date_from:
            query += " AND d.date >= ?"
            params.append(date_from)
        if date_to:
            query += " AND d.date <= ?"
            params.append(date_to)
        query += " ORDER BY d.date DESC, d.name ASC"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return [_daily_worker_row_to_dict(row) for row in rows]

    @router.post("/daily-workers")
    def add_daily_worker(body: DailyWorkerCreate):
        _check_pin(body.pin)
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="이름을 입력하세요.")
        if body.hourlyRate <= 0:
            raise HTTPException(status_code=400, detail="시급을 1원 이상 입력하세요.")
        bank_name = body.bankName.strip()
        account_holder = body.accountHolder.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        resident_registration_number = re.sub(r"[^0-9]", "", body.residentRegistrationNumber)
        if any((bank_name, account_holder, account_number)) and not all((bank_name, account_holder, account_number)):
            raise HTTPException(status_code=400, detail="계좌정보를 입력할 때는 은행, 예금주, 계좌번호를 모두 입력하세요.")
        if resident_registration_number and len(resident_registration_number) != 13:
            raise HTTPException(status_code=400, detail="주민등록번호 13자리를 정확히 입력하세요.")
        try:
            start_kst = datetime.strptime(
                f"{body.date} {body.startTime}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
            end_kst = datetime.strptime(
                f"{body.date} {body.endTime}", "%Y-%m-%d %H:%M"
            ).replace(tzinfo=KST)
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 또는 시간 형식이 올바르지 않습니다.")
        if end_kst <= start_kst:
            raise HTTPException(status_code=400, detail="퇴근 시간은 출근 시간보다 늦어야 합니다.")

        conn = get_db()
        try:
            in_cursor = conn.execute(
                "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, '출근', ?, ?)",
                (name, start_kst.astimezone(timezone.utc).isoformat(), body.date),
            )
            out_cursor = conn.execute(
                "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, '퇴근', ?, ?)",
                (name, end_kst.astimezone(timezone.utc).isoformat(), body.date),
            )
            conn.execute(
                "INSERT INTO attendance_daily_workers "
                "(name, date, start_time, end_time, check_in_record_id, check_out_record_id, "
                "bank_name, account_holder, account_number, resident_registration_number, payment_completed, hourly_rate, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (
                    name, body.date, body.startTime, body.endTime,
                    in_cursor.lastrowid, out_cursor.lastrowid,
                    bank_name, account_holder, account_number,
                    resident_registration_number, body.hourlyRate, _now_kst().isoformat(),
                ),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            if "UNIQUE" in str(exc).upper():
                raise HTTPException(status_code=409, detail="같은 이름과 날짜의 기록이 이미 있습니다.")
            raise
        finally:
            conn.close()
        return {"ok": True}

    @router.patch("/daily-workers/{entry_id}/account")
    def update_daily_worker_account(entry_id: int, body: DailyWorkerAccountUpdate):
        _check_pin(body.pin)
        bank_name = body.bankName.strip()
        account_holder = body.accountHolder.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        if any((bank_name, account_holder, account_number)) and not all((bank_name, account_holder, account_number)):
            raise HTTPException(status_code=400, detail="계좌정보를 수정할 때는 은행, 예금주, 계좌번호를 모두 입력하세요.")
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM attendance_daily_workers WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="일일 알바 기록을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_daily_workers SET bank_name = ?, account_holder = ?, account_number = ? WHERE id = ?",
            (bank_name, account_holder, account_number, entry_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/daily-workers/{entry_id}/resident-number")
    def update_daily_worker_resident_number(entry_id: int, body: DailyWorkerResidentNumberUpdate):
        _check_pin(body.pin)
        resident_registration_number = re.sub(r"[^0-9]", "", body.residentRegistrationNumber)
        if resident_registration_number and len(resident_registration_number) != 13:
            raise HTTPException(status_code=400, detail="주민등록번호 13자리를 정확히 입력하세요.")
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM attendance_daily_workers WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="일일 알바 기록을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_daily_workers SET resident_registration_number = ? WHERE id = ?",
            (resident_registration_number, entry_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.patch("/daily-workers/{entry_id}/payment")
    def update_daily_worker_payment(entry_id: int, body: DailyWorkerPaymentUpdate):
        _check_pin(body.pin)
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM attendance_daily_workers WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="일일 알바 기록을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_daily_workers SET payment_completed = ? WHERE id = ?",
            (1 if body.completed else 0, entry_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "paymentCompleted": body.completed}

    @router.delete("/daily-workers/{entry_id}")
    def delete_daily_worker(entry_id: int, body: DailyWorkerDelete):
        _check_pin(body.pin)
        conn = get_db()
        row = conn.execute(
            "SELECT check_in_record_id, check_out_record_id FROM attendance_daily_workers WHERE id = ?",
            (entry_id,),
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="일일 알바 기록을 찾을 수 없습니다.")
        conn.execute("DELETE FROM attendance_records WHERE id IN (?, ?)", (row["check_in_record_id"], row["check_out_record_id"]))
        conn.execute("DELETE FROM attendance_daily_workers WHERE id = ?", (entry_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    # ── 입금 요청 ──────────────────────────────────────
    def _payment_request_row_to_dict(row):
        return {
            "id": row["id"],
            "date": row["date"],
            "bankName": row["bank_name"],
            "accountHolder": row["account_holder"],
            "accountNumber": row["account_number"],
            "amount": row["amount"],
            "content": row["content"],
            "residentRegistrationNumber": row["resident_registration_number"],
            "paymentCompleted": bool(row["payment_completed"]),
        }

    @router.get("/payment-requests")
    def list_payment_requests(pin: str = "", date: str = ""):
        _check_pin(pin)
        conn = get_db()
        query = (
            "SELECT id, date, bank_name, account_holder, account_number, amount, content, "
            "resident_registration_number, payment_completed "
            "FROM attendance_payment_requests"
        )
        params = []
        if date:
            query += " WHERE date = ?"
            params.append(date)
        query += " ORDER BY date DESC, id DESC"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return [_payment_request_row_to_dict(row) for row in rows]

    @router.post("/payment-requests")
    def add_payment_request(body: PaymentRequestCreate):
        _check_pin(body.pin)
        try:
            datetime.strptime(body.date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")
        bank_name = body.bankName.strip()
        account_holder = body.accountHolder.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        content = body.content.strip()
        resident_number = re.sub(r"[^0-9]", "", body.residentRegistrationNumber)
        if not all((bank_name, account_holder, account_number, content)):
            raise HTTPException(status_code=400, detail="은행, 예금주, 계좌번호, 내용을 모두 입력하세요.")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="이체금액은 0원보다 커야 합니다.")
        if resident_number and len(resident_number) != 13:
            raise HTTPException(status_code=400, detail="주민등록번호 13자리를 정확히 입력하세요.")
        conn = get_db()
        assignee = conn.execute(
            "SELECT username, display_name FROM users WHERE display_name = ? LIMIT 1",
            ("김승일",),
        ).fetchone()
        if not assignee:
            assignee = conn.execute(
                "SELECT username, display_name FROM users "
                "WHERE display_name LIKE ? OR username LIKE ? LIMIT 1",
                ("%김승일%", "%kimsungil%"),
            ).fetchone()
        if not assignee:
            conn.close()
            raise HTTPException(status_code=400, detail="김승일 계정을 찾지 못했습니다.")
        cursor = conn.execute(
            "INSERT INTO attendance_payment_requests "
            "(date, bank_name, account_holder, account_number, amount, content, "
            "resident_registration_number, payment_completed, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                body.date, bank_name, account_holder, account_number, body.amount,
                content, resident_number, _now_kst().isoformat(),
            ),
        )
        conn.execute(
            "INSERT INTO requests "
            "(requester_username, requester_display, assignee_username, assignee_display, "
            "text, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
            (
                "attendance_system",
                "입금 요청 자동알림",
                assignee["username"],
                (assignee["display_name"] or "").strip() or "김승일",
                f"{content} 입금필요",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, date, bank_name, account_holder, account_number, amount, content, "
            "resident_registration_number, payment_completed "
            "FROM attendance_payment_requests WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
        conn.close()
        return _payment_request_row_to_dict(row)

    @router.patch("/payment-requests/{request_id}/payment")
    def update_payment_request_payment(request_id: int, body: PaymentRequestPaymentUpdate):
        _check_pin(body.pin)
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM attendance_payment_requests WHERE id = ?", (request_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="입금 요청을 찾을 수 없습니다.")
        conn.execute(
            "UPDATE attendance_payment_requests SET payment_completed = ? WHERE id = ?",
            (1 if body.completed else 0, request_id),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "paymentCompleted": body.completed}

    @router.patch("/payment-requests/{request_id}")
    def update_payment_request(request_id: int, body: PaymentRequestUpdate):
        _check_pin(body.pin)
        try:
            datetime.strptime(body.date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다.")
        bank_name = body.bankName.strip()
        account_holder = body.accountHolder.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        content = body.content.strip()
        resident_number = re.sub(r"[^0-9]", "", body.residentRegistrationNumber)
        if not all((bank_name, account_holder, account_number, content)) or body.amount <= 0:
            raise HTTPException(status_code=400, detail="입금 요청 정보를 확인하세요.")
        if resident_number and len(resident_number) != 13:
            raise HTTPException(status_code=400, detail="주민등록번호 13자리를 정확히 입력하세요.")
        conn = get_db()
        conn.execute(
            "UPDATE attendance_payment_requests SET date = ?, bank_name = ?, account_holder = ?, "
            "account_number = ?, amount = ?, content = ?, resident_registration_number = ? WHERE id = ?",
            (body.date, bank_name, account_holder, account_number, body.amount, content, resident_number, request_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, date, bank_name, account_holder, account_number, amount, content, "
            "resident_registration_number, payment_completed FROM attendance_payment_requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="입금 요청을 찾을 수 없습니다.")
        return _payment_request_row_to_dict(row)

    @router.delete("/payment-requests/{request_id}")
    def delete_payment_request(request_id: int, body: PaymentRequestDelete):
        _check_pin(body.pin)
        conn = get_db()
        row = conn.execute(
            "SELECT id FROM attendance_payment_requests WHERE id = ?", (request_id,)
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="입금 요청을 찾을 수 없습니다.")
        conn.execute("DELETE FROM attendance_payment_requests WHERE id = ?", (request_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

    def _studio_payment_row_to_dict(row):
        return {
            "id": row["id"], "studioName": row["studio_name"],
            "usageTime": row["usage_time"], "amount": row["amount"],
            "vatAmount": row["vat_amount"],
            "bankName": row["bank_name"], "accountNumber": row["account_number"],
            "accountHolder": row["account_holder"], "modelName": row["model_name"],
            "modelMemberId": row["model_member_id"],
            "modelPayment": row["model_payment"], "shootDate": row["shoot_date"],
            "paymentCompleted": bool(row["payment_completed"]),
        }

    def _resolve_hourly_rate_for_date(conn, member_id: int, date: str, fallback_rate: int) -> int:
        row = conn.execute(
            "SELECT hourly_rate FROM attendance_member_hourly_rate_history "
            "WHERE member_id = ? AND effective_date <= ? "
            "ORDER BY effective_date DESC, id DESC LIMIT 1",
            (member_id, date),
        ).fetchone()
        return row["hourly_rate"] if row and row["hourly_rate"] else fallback_rate

    def _validate_studio_model(conn, model_member_id: int, usage_time: str):
        try:
            usage_hours = float(usage_time)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="이용시간은 숫자로 입력하세요.")
        if usage_hours <= 0:
            raise HTTPException(status_code=400, detail="이용시간은 0보다 커야 합니다.")
        member = conn.execute(
            "SELECT id, name, hourly_rate, pay_type FROM attendance_members WHERE id = ?",
            (model_member_id,),
        ).fetchone()
        if not member:
            raise HTTPException(status_code=404, detail="모델을 찾을 수 없습니다.")
        if member["pay_type"] != "studio":
            raise HTTPException(status_code=400, detail="급여방식이 스튜디오인 직원만 등록할 수 있습니다.")
        return member, usage_hours

    @router.get("/studio-payments")
    def list_studio_payments(
        pin: str = "",
        date: str = "",
        date_from: str = "",
        date_to: str = "",
        member_id: int | None = None,
    ):
        _check_pin(pin)
        if date:
            date_from = date
            date_to = date
        for value in (date_from, date_to):
            if value:
                try:
                    datetime.strptime(value, "%Y-%m-%d")
                except ValueError:
                    raise HTTPException(status_code=400, detail="조회 날짜 형식이 올바르지 않습니다.")
        if date_from and date_to and date_from > date_to:
            raise HTTPException(status_code=400, detail="조회 시작일은 종료일보다 늦을 수 없습니다.")
        conn = get_db()
        query = "SELECT * FROM attendance_studio_payments"
        params = []
        conditions = []
        if date_from:
            conditions.append("shoot_date >= ?")
            params.append(date_from)
        if date_to:
            conditions.append("shoot_date <= ?")
            params.append(date_to)
        if member_id is not None:
            conditions.append("model_member_id = ?")
            params.append(member_id)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY shoot_date DESC, id DESC"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return [_studio_payment_row_to_dict(row) for row in rows]

    @router.get("/studio-payments/history")
    def get_studio_payment_history(studio_name: str, pin: str = ""):
        _check_pin(pin)
        name = studio_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="스튜디오 이름을 입력하세요.")
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM attendance_studio_payments WHERE studio_name = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (name,),
        ).fetchone()
        conn.close()
        return _studio_payment_row_to_dict(row) if row else None

    @router.post("/studio-payments")
    def add_studio_payment(body: StudioPaymentCreate):
        _check_pin(body.pin)
        try:
            datetime.strptime(body.shootDate, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="촬영예정일 형식이 올바르지 않습니다.")
        studio_name = body.studioName.strip()
        usage_time = body.usageTime.strip()
        bank_name = body.bankName.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        account_holder = body.accountHolder.strip()
        if not all((studio_name, usage_time, bank_name, account_number, account_holder)):
            raise HTTPException(status_code=400, detail="스튜디오 입금 정보를 모두 입력하세요.")
        if body.amount <= 0 or body.vatAmount < 0:
            raise HTTPException(status_code=400, detail="입금액을 확인하세요.")
        conn = get_db()
        try:
            member, usage_hours = _validate_studio_model(conn, body.modelMemberId, usage_time)
        except HTTPException:
            conn.close()
            raise
        model_name = member["name"]
        rate = _resolve_hourly_rate_for_date(conn, member["id"], body.shootDate, member["hourly_rate"])
        model_payment = round(rate * usage_hours)
        assignee = conn.execute(
            "SELECT username, display_name FROM users WHERE display_name = ? LIMIT 1",
            ("김승일",),
        ).fetchone()
        if not assignee:
            assignee = conn.execute(
                "SELECT username, display_name FROM users "
                "WHERE display_name LIKE ? OR username LIKE ? LIMIT 1",
                ("%김승일%", "%kimsungil%"),
            ).fetchone()
        if not assignee:
            conn.close()
            raise HTTPException(status_code=400, detail="김승일 계정을 찾지 못했습니다.")
        cursor = conn.execute(
            "INSERT INTO attendance_studio_payments "
            "(studio_name, usage_time, amount, vat_amount, bank_name, account_number, account_holder, "
            "model_name, model_member_id, model_payment, shoot_date, payment_completed, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (studio_name, usage_time, body.amount, body.vatAmount, bank_name, account_number, account_holder,
             model_name, member["id"], model_payment, body.shootDate, _now_kst().isoformat()),
        )
        conn.execute(
            "INSERT INTO requests "
            "(requester_username, requester_display, assignee_username, assignee_display, "
            "text, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
            (
                "attendance_system",
                "입금 요청 자동알림",
                assignee["username"],
                (assignee["display_name"] or "").strip() or "김승일",
                f"{studio_name} 입금필요",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM attendance_studio_payments WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        conn.close()
        return _studio_payment_row_to_dict(row)

    @router.patch("/studio-payments/{payment_id}/payment")
    def update_studio_payment(payment_id: int, body: PaymentRequestPaymentUpdate):
        _check_pin(body.pin)
        conn = get_db()
        row = conn.execute("SELECT id FROM attendance_studio_payments WHERE id = ?", (payment_id,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="스튜디오 입금 정보를 찾을 수 없습니다.")
        conn.execute("UPDATE attendance_studio_payments SET payment_completed = ? WHERE id = ?",
                     (1 if body.completed else 0, payment_id))
        conn.commit()
        conn.close()
        return {"ok": True, "paymentCompleted": body.completed}

    @router.patch("/studio-payments/{payment_id}")
    def edit_studio_payment(payment_id: int, body: StudioPaymentUpdate):
        _check_pin(body.pin)
        try:
            datetime.strptime(body.shootDate, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="촬영예정일 형식이 올바르지 않습니다.")
        studio_name = body.studioName.strip()
        usage_time = body.usageTime.strip()
        bank_name = body.bankName.strip()
        account_number = re.sub(r"[^0-9]", "", body.accountNumber)
        account_holder = body.accountHolder.strip()
        if not all((studio_name, usage_time, bank_name, account_number, account_holder)):
            raise HTTPException(status_code=400, detail="스튜디오 입금 정보를 모두 입력하세요.")
        if body.amount <= 0 or body.vatAmount < 0:
            raise HTTPException(status_code=400, detail="입금액을 확인하세요.")
        conn = get_db()
        try:
            member, usage_hours = _validate_studio_model(conn, body.modelMemberId, usage_time)
        except HTTPException:
            conn.close()
            raise
        model_name = member["name"]
        rate = _resolve_hourly_rate_for_date(conn, member["id"], body.shootDate, member["hourly_rate"])
        model_payment = round(rate * usage_hours)
        conn.execute(
            "UPDATE attendance_studio_payments SET studio_name = ?, usage_time = ?, amount = ?, vat_amount = ?, "
            "bank_name = ?, account_number = ?, account_holder = ?, model_name = ?, model_member_id = ?, "
            "model_payment = ?, shoot_date = ? WHERE id = ?",
            (studio_name, usage_time, body.amount, body.vatAmount, bank_name, account_number, account_holder,
             model_name, member["id"], model_payment, body.shootDate, payment_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM attendance_studio_payments WHERE id = ?", (payment_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="스튜디오 입금 정보를 찾을 수 없습니다.")
        return _studio_payment_row_to_dict(row)

    @router.delete("/studio-payments/{payment_id}")
    def delete_studio_payment(payment_id: int, body: PaymentRequestDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute("DELETE FROM attendance_studio_payments WHERE id = ?", (payment_id,))
        conn.commit()
        conn.close()
        return {"ok": True}

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
        normalized = _normalize_attendance_rows(conn, rows)
        conn.close()
        return normalized

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
        existing = conn.execute(
            "SELECT member_name, type FROM attendance_records WHERE id = ?",
            (record_id,),
        ).fetchone()
        conn.execute(
            "UPDATE attendance_records SET timestamp = ?, date = ? WHERE id = ?",
            (dt_utc.isoformat(), body.date, record_id),
        )
        conn.commit()
        if existing and existing["type"] == "출근":
            _check_checkin_exception(
                conn, existing["member_name"], body.date, dt_utc.isoformat()
            )
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

    # ── 스케줄관리 ──────────────────────────────────────

    def _fixed_rule_row_to_dict(r):
        return {
            "id": r["id"], "memberId": r["member_id"], "weekday": r["weekday"],
            "startTime": r["start_time"], "endTime": r["end_time"],
            "effectiveFrom": r["effective_from"], "status": r["status"],
        }

    def _override_row_to_dict(r):
        return {
            "id": r["id"], "memberId": r["member_id"], "weekday": r["weekday"],
            "date": r["date"], "startTime": r["start_time"], "endTime": r["end_time"],
            "status": r["status"],
        }

    def _memo_row_to_dict(r):
        return {"id": r["id"], "memberId": r["member_id"], "date": r["date"], "content": r["content"]}

    @router.get("/schedule")
    def get_schedule(pin: str = ""):
        _check_pin(pin)
        conn = get_db()
        fixed_rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        override_rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        memo_rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {
            "fixedRules": [_fixed_rule_row_to_dict(r) for r in fixed_rows],
            "overrides": [_override_row_to_dict(r) for r in override_rows],
            "memos": [_memo_row_to_dict(r) for r in memo_rows],
        }

    def _hours_between(start: str, end: str) -> float:
        sh, sm = (int(x) for x in start.split(":"))
        eh, em = (int(x) for x in end.split(":"))
        return (eh + em / 60) - (sh + sm / 60)

    class ScheduleFixedRuleItem(BaseModel):
        weekday: int
        startTime: str
        endTime: str
        status: str

    class ScheduleFixedRulesBulkCreate(BaseModel):
        pin: str
        memberId: int
        effectiveFrom: str
        rules: list[ScheduleFixedRuleItem]

    @router.post("/schedule/fixed-rules/bulk")
    def add_schedule_fixed_rules_bulk(body: ScheduleFixedRulesBulkCreate):
        _check_pin(body.pin)
        if not body.rules:
            raise HTTPException(status_code=400, detail="rules가 비어있습니다.")
        for item in body.rules:
            if item.status == "scheduled" and _hours_between(item.startTime, item.endTime) <= 0:
                raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 늦어야 합니다.")
        total_hours = sum(
            _hours_between(item.startTime, item.endTime)
            for item in body.rules if item.status == "scheduled"
        )
        if total_hours > 15:
            raise HTTPException(status_code=400, detail="직원별 주 15시간을 초과할 수 없습니다.")

        conn = get_db()
        now = _now_kst().isoformat()
        # get_db()는 Turso 설정 시 _TursoHTTPConn을 반환하는데 executemany가 없으므로 execute를 반복 호출한다.
        for item in body.rules:
            conn.execute(
                "INSERT INTO attendance_schedule_fixed_rules "
                "(member_id, weekday, start_time, end_time, effective_from, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (body.memberId, item.weekday, item.startTime, item.endTime, body.effectiveFrom, item.status, now),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules ORDER BY effective_from ASC, id ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "fixedRules": [_fixed_rule_row_to_dict(r) for r in rows]}

    def _member_week_hours(conn, member_id: int, date_str: str, pending: dict | None = None) -> float:
        """date_str가 속한 월~금 주간의 예정 근무시간 합계.
        pending이 있으면 그 날짜의 override는 DB 값 대신 pending 값으로 계산한다
        (저장 전 검증용 — 공휴일은 고려하지 않는다, Global Constraints 참고)."""
        d = datetime.strptime(date_str, "%Y-%m-%d")
        monday = d - timedelta(days=d.weekday())
        week_dates = [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]

        placeholders = ",".join("?" * len(week_dates))
        existing_overrides = {
            r["date"]: r
            for r in conn.execute(
                f"SELECT date, start_time, end_time, status FROM attendance_schedule_overrides "
                f"WHERE member_id = ? AND date IN ({placeholders})",
                (member_id, *week_dates),
            ).fetchall()
        }
        fixed_rules = conn.execute(
            "SELECT weekday, start_time, end_time, effective_from, status "
            "FROM attendance_schedule_fixed_rules WHERE member_id = ? "
            "ORDER BY effective_from DESC, id DESC",
            (member_id,),
        ).fetchall()

        def fixed_for(weekday, on_date):
            for r in fixed_rules:
                if r["weekday"] == weekday and r["status"] == "scheduled" and r["effective_from"] <= on_date:
                    return r
            return None

        total = 0.0
        for i, wd_date in enumerate(week_dates):
            weekday = i + 1
            if pending and pending["date"] == wd_date:
                if pending["status"] == "scheduled":
                    total += _hours_between(pending["start_time"], pending["end_time"])
                continue
            override = existing_overrides.get(wd_date)
            if override:
                if override["status"] == "scheduled":
                    total += _hours_between(override["start_time"], override["end_time"])
                continue
            rule = fixed_for(weekday, wd_date)
            if rule:
                total += _hours_between(rule["start_time"], rule["end_time"])
        return total

    class ScheduleOverrideUpsert(BaseModel):
        pin: str
        memberId: int
        weekday: int
        date: str
        startTime: str
        endTime: str
        status: str

    class ScheduleOverrideDelete(BaseModel):
        pin: str
        memberId: int
        date: str

    @router.post("/schedule/overrides")
    def upsert_schedule_override(body: ScheduleOverrideUpsert):
        _check_pin(body.pin)
        if body.status == "scheduled" and _hours_between(body.startTime, body.endTime) <= 0:
            raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 늦어야 합니다.")

        conn = get_db()
        if body.status == "scheduled":
            pending = {
                "date": body.date, "status": body.status,
                "start_time": body.startTime, "end_time": body.endTime,
            }
            total_hours = _member_week_hours(conn, body.memberId, body.date, pending)
            if total_hours > 15:
                conn.close()
                raise HTTPException(status_code=400, detail="직원별 주 15시간을 초과할 수 없습니다.")

        conn.execute(
            "INSERT INTO attendance_schedule_overrides "
            "(member_id, weekday, date, start_time, end_time, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(member_id, date) DO UPDATE SET "
            "weekday = excluded.weekday, start_time = excluded.start_time, "
            "end_time = excluded.end_time, status = excluded.status",
            (body.memberId, body.weekday, body.date, body.startTime, body.endTime, body.status, _now_kst().isoformat()),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    @router.delete("/schedule/overrides")
    def delete_schedule_override(body: ScheduleOverrideDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute(
            "DELETE FROM attendance_schedule_overrides WHERE member_id = ? AND date = ?",
            (body.memberId, body.date),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, weekday, date, start_time, end_time, status "
            "FROM attendance_schedule_overrides ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "overrides": [_override_row_to_dict(r) for r in rows]}

    class ScheduleMemoUpsert(BaseModel):
        pin: str
        memberId: int
        date: str
        content: str

    class ScheduleMemoDelete(BaseModel):
        pin: str
        memberId: int
        date: str

    @router.post("/schedule/memos")
    def upsert_schedule_memo(body: ScheduleMemoUpsert):
        _check_pin(body.pin)
        conn = get_db()
        content = body.content.strip()
        if content:
            conn.execute(
                "INSERT INTO attendance_schedule_memos (member_id, date, content, created_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(member_id, date) DO UPDATE SET content = excluded.content",
                (body.memberId, body.date, content, _now_kst().isoformat()),
            )
        else:
            conn.execute(
                "DELETE FROM attendance_schedule_memos WHERE member_id = ? AND date = ?",
                (body.memberId, body.date),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "memos": [_memo_row_to_dict(r) for r in rows]}

    @router.delete("/schedule/memos")
    def delete_schedule_memo(body: ScheduleMemoDelete):
        _check_pin(body.pin)
        conn = get_db()
        conn.execute(
            "DELETE FROM attendance_schedule_memos WHERE member_id = ? AND date = ?",
            (body.memberId, body.date),
        )
        conn.commit()
        rows = conn.execute(
            "SELECT id, member_id, date, content FROM attendance_schedule_memos ORDER BY date ASC"
        ).fetchall()
        conn.close()
        return {"ok": True, "memos": [_memo_row_to_dict(r) for r in rows]}

    return router
