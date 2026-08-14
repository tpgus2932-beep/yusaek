from __future__ import annotations


def load_misong_qty_by_code(get_shared_db) -> dict[str, int]:
    """상품코드 → 미송수량(노예김승일 미송관리, misong_items 테이블) 합계. 실패 시 빈 매핑."""
    conn = get_shared_db()
    try:
        rows = conn.execute(
            "SELECT original_f, SUM(F) AS qty FROM misong_items "
            "WHERE TRIM(original_f) != '' GROUP BY original_f"
        ).fetchall()
        return {
            " ".join(str(r["original_f"] or "").split()): int(r["qty"] or 0)
            for r in rows
            if " ".join(str(r["original_f"] or "").split())
        }
    except Exception:
        return {}
    finally:
        conn.close()
