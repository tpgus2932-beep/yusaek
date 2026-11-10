"""비품관리(겉포장지) 재고 차감.

바코드 > 확장주문검색 "EZAdmin에서 불러오기"로 가져온 DS00 출고 행(상품 1줄 = 1행)을 받아
상품명 맨 앞 숫자(1/2/3, 그 외는 기본=0)로 포장지 종류를 정하고 재고에서 차감한다.
송장 1건당 포장지 1장을 차감하고, 같은 송장번호(합포)는 상품들 중 가장 큰 숫자 종류를 따른다. (합산 공식은 추후 도입 예정)
이미 차감한 행(seq)은 날짜별 키 목록에 저장해 두고 다시 차감하지 않는다.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

_KST = ZoneInfo("Asia/Seoul")
_LOCK = threading.Lock()
_HTML_RE = re.compile(r"<[^>]+>")
_PREFIX_RE = re.compile(r"^\s*([1-3])(?!\d)")

KINDS = (0, 1, 2, 3)
LABELS = {0: "기본", 1: "1", 2: "2", 3: "3"}
SIZES = {0: "32x42", 1: "35x45", 2: "40x50", 3: "45x60"}


def _clean(value) -> str:
    return _HTML_RE.sub("", str(value or "")).strip()


def kind_of(product_name: str) -> int:
    """상품명 맨 앞의 1/2/3 이면 그 종류, 숫자가 아니면 전부 기본(0)."""
    m = _PREFIX_RE.match(_clean(product_name))
    return int(m.group(1)) if m else 0


def _qty_of(cell: dict) -> int:
    try:
        return int(float(_clean(cell.get("qty", "1")) or "1"))
    except (TypeError, ValueError):
        return 1


def init_supplies_tables(get_db) -> None:
    conn = get_db()
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS supplies_stock ("
            "kind INTEGER PRIMARY KEY, qty INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '')"
        )
        # 차감 완료한 출고 행 고유키(seq)를 불러온 날짜별로 JSON 배열로 보관
        conn.execute(
            "CREATE TABLE IF NOT EXISTS supplies_deducted_keys ("
            "work_date TEXT PRIMARY KEY, keys_json TEXT NOT NULL DEFAULT '[]')"
        )
        # 날짜(KST) x 종류별 순증감(차감 -, 입고 +) - 재고 옆 괄호 표시용
        conn.execute(
            "CREATE TABLE IF NOT EXISTS supplies_log ("
            "log_date TEXT NOT NULL, kind INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 0, "
            "PRIMARY KEY (log_date, kind))"
        )
        for k in KINDS:
            conn.execute("INSERT OR IGNORE INTO supplies_stock (kind, qty, updated_at) VALUES (?, 0, '')", (k,))
        conn.commit()
    finally:
        conn.close()


def _today() -> str:
    return datetime.now(_KST).date().isoformat()


def _add_log(conn, kind: int, delta: int) -> None:
    """오늘(KST) 순증감을 더한다. 차감은 음수, 입고(재고 올림)는 양수."""
    today = _today()
    conn.execute("INSERT OR IGNORE INTO supplies_log (log_date, kind, qty) VALUES (?, ?, 0)", (today, kind))
    conn.execute("UPDATE supplies_log SET qty = qty + ? WHERE log_date = ? AND kind = ?", (delta, today, kind))


def get_state(get_db) -> list[dict]:
    conn = get_db()
    try:
        stock = {int(r[0]): int(r[1]) for r in conn.execute("SELECT kind, qty FROM supplies_stock").fetchall()}
        today = {int(r[0]): int(r[1]) for r in conn.execute(
            "SELECT kind, qty FROM supplies_log WHERE log_date = ?", (_today(),)
        ).fetchall()}
    finally:
        conn.close()
    return [
        {"kind": k, "label": LABELS[k], "size": SIZES[k], "qty": stock.get(k, 0), "today": today.get(k, 0)}
        for k in KINDS
    ]


def set_stock(get_db, values: dict) -> None:
    conn = get_db()
    try:
        now = datetime.now(_KST).replace(tzinfo=None, microsecond=0).isoformat(sep=" ")
        for k in KINDS:
            raw = values.get(str(k), values.get(k))
            if raw is None or str(raw).strip() == "":
                continue
            qty = int(float(str(raw).replace(",", "")))
            old = conn.execute("SELECT qty, updated_at FROM supplies_stock WHERE kind = ?", (k,)).fetchone()
            # 처음 입력하는 값은 기준 재고라 입고로 치지 않는다
            delta = qty - int(old[0]) if old and old[1] else 0
            conn.execute("UPDATE supplies_stock SET qty = ?, updated_at = ? WHERE kind = ?", (qty, now, k))
            if delta:
                _add_log(conn, k, delta)
        conn.commit()
    finally:
        conn.close()


def _line_key(cell: dict, invoice: str, occurrence: int) -> str:
    seq = _clean(cell.get("seq", ""))
    if seq:
        return f"s:{seq}"
    # seq 가 없으면 송장+상품코드+옵션+그 송장 안에서의 순번으로 대신한다
    return f"t:{invoice}|{_clean(cell.get('product_id', ''))}|{_clean(cell.get('p_options', ''))}|{occurrence}"


def deduct_from_ez_rows(get_db, ez_rows: list[dict], work_date: str) -> dict:
    """DS00 행들을 종류별로 차감한다. 이미 차감한 행은 건너뛴다."""
    lines: list[dict] = []
    seen_in_invoice: dict[str, int] = {}
    for row in ez_rows or []:
        cell = (row or {}).get("cell", {}) or {}
        qty = _qty_of(cell)
        if qty <= 0:
            continue
        invoice = _clean(cell.get("trans_no", ""))
        n = seen_in_invoice.get(invoice, 0)
        seen_in_invoice[invoice] = n + 1
        lines.append({
            "invoice": invoice,
            "key": _line_key(cell, invoice, n),
            "kind": kind_of(cell.get("name", "")),
            "qty": qty,
        })

    # 합포(같은 송장번호): 송장 안 상품들 중 가장 큰 종류를 따른다. 송장번호가 없으면 행 단독.
    invoice_kind: dict[str, int] = {}
    for ln in lines:
        if ln["invoice"]:
            invoice_kind[ln["invoice"]] = max(invoice_kind.get(ln["invoice"], 0), ln["kind"])

    with _LOCK:
        conn = get_db()
        try:
            row = conn.execute("SELECT keys_json FROM supplies_deducted_keys WHERE work_date = ?", (work_date,)).fetchone()
            done = set(json.loads(row[0])) if row and row[0] else set()
            totals = {k: 0 for k in KINDS}
            new_lines = skipped = 0
            # 송장 1건 = 포장지 1장. 이미 차감한 행이 하나라도 있는 송장은 포장지를 이미 쓴 것으로 보고 다시 차감하지 않는다.
            invoice_used = {ln["invoice"] for ln in lines if ln["invoice"] and ln["key"] in done}
            for ln in lines:
                if ln["key"] in done:
                    skipped += 1
                    continue
                inv = ln["invoice"]
                if inv:
                    if inv not in invoice_used:
                        totals[invoice_kind[inv]] += 1
                        invoice_used.add(inv)
                else:
                    totals[ln["kind"]] += 1  # 송장번호가 없으면 행 하나를 한 송장으로 본다
                done.add(ln["key"])
                new_lines += 1
            if new_lines:
                now = datetime.now(_KST).replace(tzinfo=None, microsecond=0).isoformat(sep=" ")
                for kind, qty in totals.items():
                    if not qty:
                        continue
                    conn.execute("UPDATE supplies_stock SET qty = qty - ?, updated_at = ? WHERE kind = ?", (qty, now, kind))
                    _add_log(conn, kind, -qty)
                conn.execute(
                    "INSERT OR REPLACE INTO supplies_deducted_keys (work_date, keys_json) VALUES (?, ?)",
                    (work_date, json.dumps(sorted(done), ensure_ascii=False)),
                )
                conn.commit()
        finally:
            conn.close()
    return {"new_lines": new_lines, "skipped_lines": skipped, "deducted": {str(k): v for k, v in totals.items() if v}}
