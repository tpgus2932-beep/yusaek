from __future__ import annotations

from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
IDLE_SECONDS = 5 * 60  # 마지막 스캔 후 이 시간 안에 다음 스캔이 없으면 세션이 끊긴다
BUCKET_SECONDS = 10 * 60


def init_tables(get_db) -> None:
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS return_scan_starts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                started_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS return_scan_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                scanned_at TEXT NOT NULL,
                barcode TEXT NOT NULL DEFAULT '',
                last_type TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS return_scan_deletes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                deleted_at TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                barcode TEXT NOT NULL DEFAULT '',
                item_type TEXT NOT NULL DEFAULT '',
                item_text TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_return_scan_deletes_at ON return_scan_deletes(deleted_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_return_scan_log_at ON return_scan_log(scanned_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_return_scan_starts_at ON return_scan_starts(started_at)")
        conn.commit()
    finally:
        conn.close()


def _now() -> datetime:
    return datetime.now(KST)


def record_start(get_db, username: str) -> None:
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO return_scan_starts (username, started_at) VALUES (?, ?)",
            (username, _now().isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


def record_scan(get_db, username: str, barcode: str, last_type: str) -> None:
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO return_scan_log (username, scanned_at, barcode, last_type) VALUES (?, ?, ?, ?)",
            (username, _now().isoformat(), barcode, last_type or ""),
        )
        conn.commit()
    finally:
        conn.close()


def record_deletes(get_db, username: str, source: str, items: list[dict]) -> None:
    """삭제 버튼(source: 'delete' 선택삭제 / 'undo' 마지막 스캔 되돌리기) 1번 누름 = 같은 deleted_at 으로 여러 행."""
    if not items:
        return
    at = _now().isoformat()
    conn = get_db()
    try:
        for it in items:
            conn.execute(
                "INSERT INTO return_scan_deletes (username, deleted_at, source, barcode, item_type, item_text) VALUES (?, ?, ?, ?, ?, ?)",
                (username, at, source, str(it.get("scan") or ""), str(it.get("type") or ""), str(it.get("item_text") or "")[:300]),
            )
        conn.commit()
    finally:
        conn.close()


def build_sessions(starts: list, scans: list, now: datetime) -> dict:
    """starts/scans: [(username, iso_time, ...)] 를 받아 세션 목록을 만든다.

    시작 버튼(전체 API 불러오기)을 누르면 세션이 시작되고, 마지막 스캔(스캔이 없으면 시작 시각)
    이후 5분 안에 다음 스캔이 없으면 끊긴다. 끊긴 뒤 시작 없이 들어온 스캔은 세션 밖으로 센다.
    """
    users = sorted({s[0] for s in starts} | {s[0] for s in scans})
    sessions: list = []
    outside: dict = {}
    for user in users:
        events = [(datetime.fromisoformat(t), "start", None) for u, t in starts if u == user]
        events += [(datetime.fromisoformat(t), "scan", lt) for u, t, lt in scans if u == user]
        events.sort(key=lambda e: e[0])
        cur = None

        def close(c):
            if c is not None:
                sessions.append(c)

        for dt, kind, last_type in events:
            if kind == "start":
                close(cur)
                cur = {"user": user, "start": dt, "last": dt, "scans": [], "types": {}}
                continue
            if cur is not None and (dt - cur["last"]).total_seconds() <= IDLE_SECONDS:
                cur["scans"].append(dt)
                cur["last"] = dt
                key = last_type or "기타"
                cur["types"][key] = cur["types"].get(key, 0) + 1
            else:
                close(cur)
                cur = None
                outside[user] = outside.get(user, 0) + 1
        close(cur)

    out = []
    for s in sessions:
        elapsed = (s["last"] - s["start"]).total_seconds()
        count = len(s["scans"])
        buckets = [0] * (int(elapsed // BUCKET_SECONDS) + 1)
        for t in s["scans"]:
            buckets[int((t - s["start"]).total_seconds() // BUCKET_SECONDS)] += 1
        out.append(
            {
                "user": s["user"],
                "start": s["start"].isoformat(),
                "end": s["last"].isoformat(),
                "active": (now - s["last"]).total_seconds() <= IDLE_SECONDS,
                "count": count,
                "elapsed_seconds": int(elapsed),
                "per_10min": round(count * BUCKET_SECONDS / elapsed, 1) if elapsed > 0 else None,
                "buckets": [
                    {"label": f"{i * 10}~{(i + 1) * 10}분", "count": c} for i, c in enumerate(buckets)
                ],
                "types": s["types"],
            }
        )
    out.sort(key=lambda x: x["start"], reverse=True)
    return {"sessions": out, "outside_scans": outside, "idle_seconds": IDLE_SECONDS}


def get_stats(get_db, days: int) -> dict:
    now = _now()
    since = (now.date() - timedelta(days=max(1, days) - 1)).isoformat()
    conn = get_db()
    try:
        starts = [
            (r["username"], r["started_at"])
            for r in conn.execute(
                "SELECT username, started_at FROM return_scan_starts WHERE started_at >= ?", (since,)
            ).fetchall()
        ]
        scans = [
            (r["username"], r["scanned_at"], r["last_type"])
            for r in conn.execute(
                "SELECT username, scanned_at, last_type FROM return_scan_log WHERE scanned_at >= ?", (since,)
            ).fetchall()
        ]
        deletes = [
            {
                "user": r["username"], "at": r["deleted_at"], "source": r["source"], "barcode": r["barcode"],
                "type": r["item_type"], "text": r["item_text"],
            }
            for r in conn.execute(
                "SELECT username, deleted_at, source, barcode, item_type, item_text FROM return_scan_deletes "
                "WHERE deleted_at >= ? ORDER BY id DESC",
                (since,),
            ).fetchall()
        ]
    finally:
        conn.close()
    data = build_sessions(starts, scans, now)
    data["total_scans"] = len(scans)
    data["deletes"] = deletes[:500]
    data["delete_items"] = len(deletes)
    data["delete_clicks"] = len({(d["user"], d["at"]) for d in deletes})
    data["delete_clicks_by_source"] = {
        src: len({(d["user"], d["at"]) for d in deletes if d["source"] == src}) for src in {d["source"] for d in deletes}
    }
    return data
