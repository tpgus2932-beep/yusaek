"""정상화 통계용 기록.

이지어드민 재고를 사람이 직접 맞춘 작업(로그 확인 입고/출고, 송장삭제 후 재고출고)을
계정·일시·상품·수량과 함께 남긴다. 재고체크 화면의 정상화는 기존
stock_check_normalize_log 에 이미 쌓이므로 여기서는 다루지 않는다.

기록 실패가 실제 재고 처리를 막으면 안 되므로 record()는 예외를 밖으로 내보내지 않는다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

_KST = timezone(timedelta(hours=9))

SOURCE_LABELS = {
    "stock_check": "재고체크 정상화",
    "log_check": "로그확인",
    "bad_stock": "악성재고 정상화",
    "invoice_delete": "송장삭제 출고",
}


def ensure_table(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS normalization_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, username TEXT DEFAULT '',
            source TEXT NOT NULL, type TEXT NOT NULL, code TEXT NOT NULL, name TEXT DEFAULT '', option TEXT DEFAULT '',
            qty INTEGER NOT NULL, ref TEXT DEFAULT '')"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_norm_log_day ON normalization_log (day)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_norm_log_code ON normalization_log (code)")


def _lookup_names(codes: set[str]) -> dict[str, tuple[str, str]]:
    """원가베이스유에서 상품코드 → (상품명, 옵션)."""
    found: dict[str, tuple[str, str]] = {}
    if not codes:
        return found
    from api.wonbe_routes import _get_wonbe_db

    wc = _get_wonbe_db()
    try:
        marks = ",".join("?" * len(codes))
        for w in wc.execute(
            f"SELECT UPPER(TRIM(상품코드)), 상품명, 색상, 사이즈 FROM wonbe WHERE UPPER(TRIM(상품코드)) IN ({marks})",
            sorted(codes),
        ).fetchall():
            found[w[0]] = (
                str(w[1] or "").strip(),
                " ".join(p for p in [str(w[2] or "").strip(), str(w[3] or "").strip()] if p),
            )
    finally:
        wc.close()
    return found


def record(get_db, *, user: str, source: str, type_: str, entries: list[dict]) -> None:
    """entries: [{code, qty, name?, option?, ref?}] 를 정상화 기록에 남긴다 (실패해도 조용히 무시)."""
    if not get_db or not entries:
        return
    try:
        try:
            names = _lookup_names({str(e.get("code") or "").strip().upper() for e in entries if not e.get("name")})
        except Exception:
            names = {}
        now = datetime.now(_KST)
        conn = get_db()
        try:
            ensure_table(conn)
            for e in entries:
                code = str(e.get("code") or "").strip()
                if not code:
                    continue
                name, option = str(e.get("name") or ""), str(e.get("option") or "")
                if not name:
                    name, option = names.get(code.upper(), ("", option))
                conn.execute(
                    "INSERT INTO normalization_log (ts, day, username, source, type, code, name, option, qty, ref) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (now.strftime("%Y-%m-%d %H:%M:%S"), now.strftime("%Y-%m-%d"), user, source, type_, code,
                     name, option, int(e.get("qty") or 0), str(e.get("ref") or "")),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        import traceback

        traceback.print_exc()
