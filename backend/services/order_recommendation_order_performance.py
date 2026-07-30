from __future__ import annotations

from datetime import datetime, timedelta

from services.order_recommendation_store import get_row, now_kst_iso, today_kst


def _date_minus(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def calc_confirm_deviation(confirmed_qty, recommended_qty):
    if confirmed_qty is None or recommended_qty is None:
        return None
    return confirmed_qty - recommended_qty


def calc_fulfillment_gap(actual_received_qty, confirmed_qty):
    if actual_received_qty is None or confirmed_qty is None:
        return None
    return actual_received_qty - confirmed_qty


def evaluate_order_performance_row(conn, yusas_code: str, date: str) -> None:
    row = get_row(conn, date, yusas_code)
    if row is None:
        return

    confirm_deviation = calc_confirm_deviation(row["confirmed_qty"], row["recommended_qty"])
    fulfillment_gap = calc_fulfillment_gap(row["actual_received_qty"], row["confirmed_qty"])

    conn.execute(
        """
        UPDATE order_recommendation_daily SET
            confirm_deviation = ?, fulfillment_gap = ?, order_performance_evaluated_at = ?
        WHERE date = ? AND yusas_code = ?
        """,
        (confirm_deviation, fulfillment_gap, now_kst_iso(), date, yusas_code),
    )
    conn.commit()


def evaluate_order_performance_all(get_db, date: str) -> int:
    conn = get_db()
    try:
        codes = [
            r["yusas_code"]
            for r in conn.execute(
                "SELECT yusas_code FROM order_recommendation_daily WHERE date = ?", (date,)
            ).fetchall()
        ]
        for code in codes:
            evaluate_order_performance_row(conn, code, date)
        return len(codes)
    finally:
        conn.close()


def aggregate_order_performance(conn, days: int, yusas_code: str | None = None) -> dict:
    start_date = _date_minus(today_kst(), days)
    query = (
        "SELECT confirm_deviation, fulfillment_gap, incoming_qty_change "
        "FROM order_recommendation_daily WHERE date >= ?"
    )
    params: list = [start_date]
    if yusas_code is not None:
        query += " AND yusas_code = ?"
        params.append(yusas_code)
    rows = conn.execute(query, params).fetchall()

    sample_count = len(rows)
    confirm_deviations = [r["confirm_deviation"] for r in rows if r["confirm_deviation"] is not None]
    fulfillment_gaps = [r["fulfillment_gap"] for r in rows if r["fulfillment_gap"] is not None]
    incoming_qty_changes = [r["incoming_qty_change"] for r in rows if r["incoming_qty_change"] is not None]

    avg_confirm_deviation = sum(confirm_deviations) / len(confirm_deviations) if confirm_deviations else None
    avg_fulfillment_gap = sum(fulfillment_gaps) / len(fulfillment_gaps) if fulfillment_gaps else None
    avg_incoming_qty_change = (
        sum(incoming_qty_changes) / len(incoming_qty_changes) if incoming_qty_changes else None
    )

    return {
        "sample_count": sample_count,
        "avg_confirm_deviation": avg_confirm_deviation,
        "avg_fulfillment_gap": avg_fulfillment_gap,
        "avg_incoming_qty_change": avg_incoming_qty_change,
    }
