from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

_KST = timezone(timedelta(hours=9))


def build_delivery_anomaly_router(*, get_current_user, get_db, get_setting, set_setting):
    router = APIRouter(prefix="/delivery-anomaly")

    @router.get("/list")
    def list_anomalies(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            """
            SELECT a.*, COUNT(c.id) AS comment_count
            FROM delivery_anomalies a
            LEFT JOIN delivery_anomaly_comments c ON c.anomaly_id = a.id
            GROUP BY a.id
            ORDER BY a.detected_at ASC
            """
        ).fetchall()
        conn.close()
        return {
            "items": [
                {
                    "id": r["id"],
                    "invoiceNo": r["invoice_no"],
                    "orderNo": r["order_no"],
                    "productName": r["product_name"],
                    "optionInfo": r["option_info"],
                    "phone": r["phone"],
                    "sentDate": r["sent_date"],
                    "status": r["status"],
                    "location": r["location"],
                    "scanDate": r["scan_date"],
                    "detectedAt": r["detected_at"],
                    "commentCount": r["comment_count"],
                }
                for r in rows
            ]
        }

    @router.get("/{anomaly_id}/comments")
    def list_comments(anomaly_id: int, user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT id, username, text, created_at FROM delivery_anomaly_comments"
            " WHERE anomaly_id = ? ORDER BY created_at ASC",
            (anomaly_id,),
        ).fetchall()
        conn.close()
        return {
            "items": [
                {"id": r["id"], "username": r["username"], "text": r["text"], "createdAt": r["created_at"]}
                for r in rows
            ]
        }

    @router.post("/{anomaly_id}/comments")
    def add_comment(
        anomaly_id: int,
        text: str = Body(..., embed=True),
        user: str = Depends(get_current_user),
    ):
        text = text.strip()
        if not text:
            raise HTTPException(400, "댓글 내용을 입력하세요")
        conn = get_db()
        exists = conn.execute(
            "SELECT id FROM delivery_anomalies WHERE id = ?", (anomaly_id,)
        ).fetchone()
        if not exists:
            conn.close()
            raise HTTPException(404, "이상현상 항목을 찾을 수 없습니다")
        created_at = datetime.now(_KST).isoformat()
        conn.execute(
            "INSERT INTO delivery_anomaly_comments (anomaly_id, username, text, created_at) VALUES (?, ?, ?, ?)",
            (anomaly_id, user, text, created_at),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "createdAt": created_at}

    return router
