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


def test_manual_record_pair_registration_creates_checkin_and_checkout(tmp_path):
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
        ("혜주", "2026-08-01T00:00:00+09:00"),
    )
    conn.commit()
    conn.close()
    client = TestClient(app)

    response = client.post("/attendance/records/pair", json={
        "pin": "1234",
        "member_name": "혜주",
        "date": "2026-08-04",
        "startTime": "09:20",
        "endTime": "14:10",
    })
    assert response.status_code == 200

    response = client.get(
        "/attendance/records",
        params={"pin": "1234", "date": "2026-08-04", "name": "혜주"},
    )
    assert response.status_code == 200
    assert [row["type"] for row in response.json()] == ["출근", "퇴근"]

    duplicate = client.post("/attendance/records/pair", json={
        "pin": "1234",
        "member_name": "혜주",
        "date": "2026-08-04",
        "startTime": "09:30",
        "endTime": "14:00",
    })
    assert duplicate.status_code == 409


def test_payment_request_registration_lookup_and_payment_status(tmp_path):
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
    client = TestClient(app)

    conn = get_db()
    conn.execute(
        "CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)"
    )
    conn.execute(
        "CREATE TABLE requests ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, requester_username TEXT NOT NULL, "
        "requester_display TEXT NOT NULL, assignee_username TEXT NOT NULL, "
        "assignee_display TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, "
        "created_at TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO users (username, display_name) VALUES (?, ?)",
        ("kimsungil", "김승일"),
    )
    conn.commit()
    conn.close()

    response = client.post("/attendance/payment-requests", json={
        "pin": "1234",
        "date": "2026-08-03",
        "bankName": "국민",
        "accountHolder": "홍길동",
        "accountNumber": "123-456-789",
        "amount": 125000,
        "content": "상품대금",
        "residentRegistrationNumber": "9001011234567",
    })
    assert response.status_code == 200
    request_id = response.json()["id"]

    response = client.get(
        "/attendance/payment-requests",
        params={"pin": "1234", "date": "2026-08-03"},
    )
    assert response.status_code == 200
    assert response.json() == [{
        "id": request_id,
        "date": "2026-08-03",
        "bankName": "국민",
        "accountHolder": "홍길동",
        "accountNumber": "123456789",
        "amount": 125000,
        "content": "상품대금",
        "residentRegistrationNumber": "9001011234567",
        "paymentCompleted": False,
    }]

    response = client.patch(f"/attendance/payment-requests/{request_id}", json={
        "pin": "1234", "date": "2026-08-03", "bankName": "국민",
        "accountHolder": "홍길동", "accountNumber": "999-888", "amount": 130000,
        "content": "수정대금", "residentRegistrationNumber": "9001011234567",
    })
    assert response.status_code == 200
    assert response.json()["amount"] == 130000
    assert response.json()["accountNumber"] == "999888"

    response = client.patch(
        f"/attendance/payment-requests/{request_id}/payment",
        json={"pin": "1234", "completed": True},
    )
    assert response.status_code == 200
    assert response.json()["paymentCompleted"] is True

    conn = get_db()
    request_row = conn.execute(
        "SELECT requester_display, assignee_username, assignee_display, text, status "
        "FROM requests"
    ).fetchone()
    conn.close()
    assert dict(request_row) == {
        "requester_display": "입금 요청 자동알림",
        "assignee_username": "kimsungil",
        "assignee_display": "김승일",
        "text": "상품대금 입금필요",
        "status": "open",
    }


def test_member_work_area_defaults_to_back_and_can_move_without_record_changes(tmp_path):
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
    client = TestClient(app)

    response = client.post(
        "/attendance/members",
        json={"pin": "1234", "name": "기존직원"},
    )
    assert response.status_code == 200
    member = client.get("/attendance/members").json()[0]
    assert member["workArea"] == "back"

    response = client.patch(
        f"/attendance/members/{member['id']}/account",
        json={
            "pin": "1234",
            "bankName": "국민",
            "accountHolder": "기존직원",
            "accountNumber": "123-456",
            "residentRegistrationNumber": "900101-1234567",
        },
    )
    assert response.status_code == 200
    accounts = client.get("/attendance/members/accounts", params={"pin": "1234"}).json()
    assert accounts[0]["accountNumber"] == "123456"
    assert accounts[0]["residentRegistrationNumber"] == "9001011234567"

    conn = get_db()
    conn.execute(
        "INSERT INTO attendance_records (member_name, date, type, timestamp) VALUES (?, ?, ?, ?)",
        ("기존직원", "2026-08-03", "출근", "2026-08-03T09:00:00+09:00"),
    )
    conn.commit()
    conn.close()

    response = client.patch(
        f"/attendance/members/{member['id']}/work-area",
        json={"pin": "1234", "workArea": "front"},
    )
    assert response.status_code == 200
    assert client.get("/attendance/members").json()[0]["workArea"] == "front"

    conn = get_db()
    record_count = conn.execute(
        "SELECT COUNT(*) AS count FROM attendance_records WHERE member_name = ?",
        ("기존직원",),
    ).fetchone()["count"]
    conn.close()
    assert record_count == 1


def test_member_fixed_allowances_are_saved_and_loaded(tmp_path):
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
    client = TestClient(app)
    assert client.post(
        "/attendance/members", json={"pin": "1234", "name": "고정수당직원"}
    ).status_code == 200
    member_id = client.get("/attendance/members").json()[0]["id"]

    response = client.put(
        f"/attendance/members/{member_id}/fixed-allowances",
        json={
            "pin": "1234",
            "allowances": [{"name": "팀장수당", "amount": 50000}],
        },
    )
    assert response.status_code == 200
    response = client.get(
        "/attendance/members/fixed-allowances", params={"pin": "1234"}
    )
    assert response.status_code == 200
    assert response.json()[str(member_id)][0] == {
        "id": 1,
        "name": "팀장수당",
        "amount": 50000,
        "fixed": True,
    }


def test_member_hourly_rate_override_can_be_set_and_cleared(tmp_path):
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
    client = TestClient(app)
    assert client.post(
        "/attendance/members", json={"pin": "1234", "name": "예외시급직원"}
    ).status_code == 200
    member = client.get("/attendance/members").json()[0]
    assert member["hourlyRate"] is None

    response = client.patch(
        f"/attendance/members/{member['id']}",
        json={"pin": "1234", "name": "예외시급직원", "hourlyRate": 12500},
    )
    assert response.status_code == 200
    updated_member = client.get("/attendance/members").json()[0]
    assert updated_member["hourlyRate"] == 12500
    assert updated_member["hourlyRateHistory"][0]["hourlyRate"] == 12500
    assert updated_member["hourlyRateHistory"][0]["effectiveDate"]

    response = client.patch(
        f"/attendance/members/{member['id']}",
        json={"pin": "1234", "name": "예외시급직원", "hourlyRate": None},
    )
    assert response.status_code == 200
    cleared_member = client.get("/attendance/members").json()[0]
    assert cleared_member["hourlyRate"] is None
    assert cleared_member["hourlyRateHistory"][-1]["hourlyRate"] is None


def test_studio_payment_registration_lookup_and_status(tmp_path):
    db_path = tmp_path / "attendance.db"

    def get_db():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn

    settings = {ATTENDANCE_DEFAULT_SCHEDULE_KEY: "done", ATTENDANCE_DEFAULT_RECORDS_KEY: "done"}
    app = FastAPI()
    app.include_router(build_attendance_router(
        get_db=get_db, get_setting=settings.get, set_setting=settings.__setitem__,
        hash_pin=lambda value: value, verify_pin=lambda value, hashed: value == hashed,
    ))
    client = TestClient(app)
    conn = get_db()
    conn.execute("CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)")
    conn.execute(
        "CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_username TEXT NOT NULL, "
        "requester_display TEXT NOT NULL, assignee_username TEXT NOT NULL, assignee_display TEXT NOT NULL, "
        "text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    conn.execute("INSERT INTO users (username, display_name) VALUES (?, ?)", ("kimsungil", "김승일"))
    conn.commit()
    conn.close()
    response = client.post("/attendance/studio-payments", json={
        "pin": "1234", "studioName": "A스튜디오", "usageTime": "3시간",
        "amount": 200000, "vatAmount": 20000, "bankName": "국민", "accountNumber": "123-456",
        "accountHolder": "홍길동", "modelName": "모델A", "modelPayment": 100000,
        "shootDate": "2026-08-03",
    })
    assert response.status_code == 200
    payment_id = response.json()["id"]
    conn = get_db()
    alert = conn.execute("SELECT assignee_display, text, status FROM requests").fetchone()
    conn.close()
    assert dict(alert) == {"assignee_display": "김승일", "text": "A스튜디오 입금필요", "status": "open"}
    response = client.get("/attendance/studio-payments", params={"pin": "1234", "date": "2026-08-03"})
    assert response.status_code == 200
    assert response.json()[0]["accountNumber"] == "123456"
    assert response.json()[0]["modelPayment"] == 100000
    assert response.json()[0]["vatAmount"] == 20000
    response = client.get(
        "/attendance/studio-payments",
        params={"pin": "1234", "date_from": "2026-08-01", "date_to": "2026-08-04"},
    )
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [payment_id]
    response = client.get(
        "/attendance/studio-payments",
        params={"pin": "1234", "date_from": "2026-08-04", "date_to": "2026-08-01"},
    )
    assert response.status_code == 400
    history = client.get(
        "/attendance/studio-payments/history",
        params={"pin": "1234", "studio_name": "A스튜디오"},
    )
    assert history.status_code == 200
    assert history.json()["accountHolder"] == "홍길동"
    response = client.patch(f"/attendance/studio-payments/{payment_id}", json={
        "pin": "1234", "studioName": "B스튜디오", "usageTime": "4시간",
        "amount": 250000, "vatAmount": 25000, "bankName": "국민", "accountNumber": "777-888",
        "accountHolder": "김수정", "modelName": "모델B", "modelPayment": 120000,
        "shootDate": "2026-08-04",
    })
    assert response.status_code == 200
    assert response.json()["studioName"] == "B스튜디오"
    assert response.json()["amount"] == 250000
    assert response.json()["vatAmount"] == 25000
    response = client.patch(
        f"/attendance/studio-payments/{payment_id}/payment",
        json={"pin": "1234", "completed": True},
    )
    assert response.status_code == 200
    assert response.json()["paymentCompleted"] is True
