import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.attendance_routes import (
    ATTENDANCE_DEFAULT_RECORDS_KEY,
    ATTENDANCE_DEFAULT_SCHEDULE_KEY,
    build_attendance_router,
)


def test_15_minute_rule_never_excludes_actual_attendance_from_payroll(tmp_path):
    db_path = tmp_path / "attendance.db"

    def get_db():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn

    settings = {
        ATTENDANCE_DEFAULT_SCHEDULE_KEY: "done",
        ATTENDANCE_DEFAULT_RECORDS_KEY: "done",
    }
    app = FastAPI()
    app.include_router(build_attendance_router(
        get_db=get_db,
        get_setting=settings.get,
        set_setting=settings.__setitem__,
        hash_pin=lambda value: value,
        verify_pin=lambda value, hashed: value == hashed,
    ))

    conn = get_db()
    conn.execute(
        "INSERT INTO attendance_members (name, created_at) VALUES (?, ?)",
        ("혜주", "2026-07-01T00:00:00+09:00"),
    )
    member_id = conn.execute(
        "SELECT id FROM attendance_members WHERE name = ?", ("혜주",)
    ).fetchone()["id"]
    conn.execute(
        "INSERT INTO attendance_schedule_overrides "
        "(member_id, date, weekday, start_time, end_time, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'scheduled', ?)",
        (member_id, "2026-07-29", 3, "09:30", "14:00", "2026-07-01T00:00:00+09:00"),
    )
    conn.execute(
        "INSERT INTO attendance_schedule_overrides "
        "(member_id, date, weekday, start_time, end_time, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'scheduled', ?)",
        (member_id, "2026-08-05", 3, "09:30", "14:00", "2026-07-01T00:00:00+09:00"),
    )
    conn.execute(
        "INSERT INTO attendance_schedule_fixed_rules "
        "(member_id, weekday, start_time, end_time, effective_from, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'scheduled', ?)",
        (member_id, 1, "09:00", "14:00", "2026-07-01", "2026-07-01T00:00:00+09:00"),
    )
    conn.executemany(
        "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, ?, ?, ?)",
        [
            ("혜주", "출근", "2026-07-29T00:58:00+00:00", "2026-07-29"),
            ("혜주", "퇴근", "2026-07-29T04:59:00+00:00", "2026-07-29"),
        ],
    )
    conn.commit()
    conn.close()

    response = TestClient(app).get(
        "/attendance/records",
        params={"pin": "1234", "date": "2026-07-29", "name": "혜주"},
    )

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 2
    assert all(row["payrollEligible"] is True for row in rows)
    check_in = next(row for row in rows if row["type"] == "출근")
    assert check_in["checkInException"] is True
    assert check_in["normalizedTimestamp"] == check_in["timestamp"]

    conn = get_db()
    conn.executemany(
        "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, ?, ?, ?)",
        [
            ("혜주", "출근", "2026-08-05T00:20:00+00:00", "2026-08-05"),
            ("혜주", "퇴근", "2026-08-05T05:00:00+00:00", "2026-08-05"),
        ],
    )
    conn.commit()
    conn.close()

    response = TestClient(app).get(
        "/attendance/records",
        params={"pin": "1234", "date": "2026-08-05", "name": "혜주"},
    )
    assert response.status_code == 200
    rows = response.json()
    assert all(row["payrollEligible"] is True for row in rows)
    check_in = next(row for row in rows if row["type"] == "출근")
    assert check_in["checkInException"] is False
    assert check_in["normalizedTimestamp"] == "2026-08-05T00:30:00+00:00"

    conn = get_db()
    conn.executemany(
        "INSERT INTO attendance_records (member_name, type, timestamp, date) VALUES (?, ?, ?, ?)",
        [
            ("혜주", "출근", "2026-08-03T00:21:00+00:00", "2026-08-03"),
            ("혜주", "퇴근", "2026-08-03T05:00:00+00:00", "2026-08-03"),
        ],
    )
    conn.commit()
    conn.close()

    response = TestClient(app).get(
        "/attendance/records",
        params={"pin": "1234", "date": "2026-08-03", "name": "혜주"},
    )
    assert response.status_code == 200
    rows = response.json()
    assert all(row["payrollEligible"] is True for row in rows)
    check_in = next(row for row in rows if row["type"] == "출근")
    assert check_in["checkInException"] is True
    assert check_in["normalizedTimestamp"] == check_in["timestamp"]
