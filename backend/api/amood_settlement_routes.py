from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

import pandas as pd
from datetime import date
from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile

from services.amood_settlement_utils import (
    aggregate_by_product,
    aggregate_realtime_by_product,
    build_settlement_download_url,
    fetch_order_details_batch,
    fetch_order_details_realtime,
    fetch_settlement_csv,
    fetch_settlement_history_list,
    now_iso,
    preprocess_product_name,
)
from services.pastelco_utils import pastelco_login


def build_amood_settlement_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/amood-settlement", tags=["amood-settlement"])

    # ── 원가 DB ──────────────────────────────────────────────────────────────

    @router.get("/cost-db")
    def cost_db_list(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT product_name, cost_price, updated_at FROM amood_product_costs ORDER BY product_name"
            ).fetchall()
            return {"ok": True, "items": [dict(r) for r in rows]}
        finally:
            conn.close()

    @router.post("/cost-db/upsert")
    def cost_db_upsert(payload: dict = Body(...), user: str = Depends(get_current_user)):
        name = str(payload.get("product_name", "")).strip()
        cost = payload.get("cost_price")
        if not name:
            raise HTTPException(status_code=400, detail="product_name 필수")
        try:
            cost = int(cost)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="cost_price는 정수여야 합니다")

        processed = preprocess_product_name(name)
        conn = get_db()
        try:
            conn.execute(
                """
                INSERT INTO amood_product_costs (product_name, cost_price, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(product_name) DO UPDATE SET cost_price = excluded.cost_price, updated_at = excluded.updated_at
                """,
                (processed, cost, now_iso()),
            )
            conn.commit()
            return {"ok": True, "product_name": processed, "cost_price": cost}
        finally:
            conn.close()

    @router.delete("/cost-db/{product_name:path}")
    def cost_db_delete(product_name: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute(
                "DELETE FROM amood_product_costs WHERE product_name = ?", (product_name,)
            )
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.post("/cost-db/import")
    async def cost_db_import(
        file: UploadFile = File(...), user: str = Depends(get_current_user)
    ):
        name = (file.filename or "").lower()
        if not (name.endswith(".xlsx") or name.endswith(".xls")):
            raise HTTPException(status_code=400, detail="xlsx/xls 파일만 가능합니다")

        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="파일이 비어있습니다")

        suffix = ".xlsx" if name.endswith(".xlsx") else ".xls"
        tmp = Path(tempfile.gettempdir()) / f"amood_cost_{uuid.uuid4().hex}{suffix}"
        tmp.write_bytes(data)

        try:
            try:
                df = pd.read_excel(tmp, engine="openpyxl", header=None)
            except Exception:
                df = pd.read_excel(tmp, engine="xlrd", header=None)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Excel 읽기 실패: {e}")
        finally:
            tmp.unlink(missing_ok=True)

        now = now_iso()
        imported = 0
        skipped = 0
        conn = get_db()
        try:
            for _, row in df.iterrows():
                raw_name = row.iloc[0] if len(row) > 0 else None
                raw_cost = row.iloc[1] if len(row) > 1 else None
                if raw_name is None or (isinstance(raw_name, float) and pd.isna(raw_name)):
                    skipped += 1
                    continue
                name_str = preprocess_product_name(str(raw_name).strip())
                if not name_str:
                    skipped += 1
                    continue
                try:
                    cost_val = int(float(raw_cost))
                except (TypeError, ValueError):
                    skipped += 1
                    continue
                conn.execute(
                    """
                    INSERT INTO amood_product_costs (product_name, cost_price, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(product_name) DO UPDATE SET cost_price = excluded.cost_price, updated_at = excluded.updated_at
                    """,
                    (name_str, cost_val, now),
                )
                imported += 1
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "imported": imported, "skipped": skipped}

    # ── 설정 ──────────────────────────────────────────────────────────────────

    @router.get("/settings")
    def get_settings(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM amood_settlement_settings WHERE key = 'per_item_cost'"
            ).fetchone()
            return {
                "ok": True,
                "per_item_cost": int(row["value"]) if row else 1900,
            }
        finally:
            conn.close()

    @router.post("/settings")
    def save_settings(payload: dict = Body(...), user: str = Depends(get_current_user)):
        if "per_item_cost" not in payload:
            raise HTTPException(status_code=400, detail="per_item_cost 필수")
        try:
            cost = int(payload["per_item_cost"])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="per_item_cost는 정수여야 합니다")
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO amood_settlement_settings (key, value) VALUES ('per_item_cost', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(cost),),
            )
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    # ── 정산 회차 목록 ────────────────────────────────────────────────────────

    @router.get("/histories/debug")
    async def debug_histories(
        start: str = Query(default="2025-06"),
        end: str = Query(default="2026-06"),
        user: str = Depends(get_current_user),
    ):
        """정산 목록 API raw 응답 확인용"""
        import httpx as _httpx
        from services.amood_settlement_utils import PASTELCO_BASE, _settlement_headers
        jwt_token = await pastelco_login()
        async with _httpx.AsyncClient(timeout=20.0) as client:
            res = await client.get(
                f"{PASTELCO_BASE}/seller/settlements/histories/",
                headers=_settlement_headers(jwt_token),
                params={"start": start, "end": end},
            )
        return {
            "status_code": res.status_code,
            "raw": res.text[:3000],
        }

    @router.get("/histories")
    async def get_histories(
        start: str = Query(default=None, description="YYYY-MM"),
        end: str = Query(default=None, description="YYYY-MM"),
        user: str = Depends(get_current_user),
    ):
        today = date.today()
        if not start:
            start = f"{today.year - 1}-{today.month:02d}"
        if not end:
            end = f"{today.year}-{today.month:02d}"
        try:
            jwt_token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")
        try:
            histories = await fetch_settlement_history_list(jwt_token, start, end)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"정산 목록 조회 실패: {e}")
        return {"ok": True, "histories": histories, "start": start, "end": end}

    # ── 정산 처리 ─────────────────────────────────────────────────────────────

    @router.post("/process")
    async def process_settlement(
        payload: dict = Body(...), user: str = Depends(get_current_user)
    ):
        history_id = payload.get("history_id")
        if not history_id:
            raise HTTPException(status_code=400, detail="history_id 필수")

        download_url = build_settlement_download_url(history_id)

        # 에이블리 로그인으로 JWT 자동 취득
        try:
            jwt_token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        # 1. CSV 다운로드 + 파싱
        try:
            csv_rows = await fetch_settlement_csv(download_url, jwt_token)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"CSV 다운로드 실패: {e}")

        if not csv_rows:
            return {"ok": True, "items": [], "summary": {"total_orders": 0}}

        # 2. 캐시 조회
        order_ids = [r["order_id"] for r in csv_rows]
        conn = get_db()
        try:
            placeholders = ",".join("?" * len(order_ids))
            cached_rows = conn.execute(
                f"SELECT order_id, name_origin, processed_name, quantity FROM amood_order_cache WHERE order_id IN ({placeholders})",
                order_ids,
            ).fetchall()
            cached = {
                r["order_id"]: {
                    "name_origin": r["name_origin"],
                    "processed_name": r["processed_name"],
                    "quantity": r["quantity"],
                }
                for r in cached_rows
            }
        finally:
            conn.close()

        # 3. 미캐시 주문 상세 조회
        try:
            order_details = await fetch_order_details_batch(
                order_ids, jwt_token, concurrency=10, cached=cached
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"주문 상세 조회 실패: {e}")

        # 4. 새 캐시 저장
        new_entries = [
            (oid, det["name_origin"], det["processed_name"], det["quantity"], now_iso())
            for oid, det in order_details.items()
            if det is not None and oid not in cached
        ]
        if new_entries:
            conn = get_db()
            try:
                conn.executemany(
                    """
                    INSERT INTO amood_order_cache (order_id, name_origin, processed_name, quantity, fetched_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(order_id) DO NOTHING
                    """,
                    new_entries,
                )
                conn.commit()
            finally:
                conn.close()

        # 5. 원가 DB 로드
        conn = get_db()
        try:
            cost_rows = conn.execute(
                "SELECT product_name, cost_price FROM amood_product_costs"
            ).fetchall()
            cost_map = {r["product_name"]: r["cost_price"] for r in cost_rows}
        finally:
            conn.close()

        # 6. 설정에서 per_item_cost 로드
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM amood_settlement_settings WHERE key = 'per_item_cost'"
            ).fetchone()
            per_item_cost = int(row["value"]) if row else 1900
        finally:
            conn.close()

        # per_item_cost 오버라이드 허용
        if "per_item_cost" in payload:
            try:
                per_item_cost = int(payload["per_item_cost"])
            except (TypeError, ValueError):
                pass

        # 7. 집계
        items, summary = aggregate_by_product(
            csv_rows, order_details, cost_map, per_item_cost
        )

        return {"ok": True, "items": items, "summary": summary}

    # ── 실시간 마진 계산 ──────────────────────────────────────────────────────

    @router.post("/realtime-margin")
    async def realtime_margin(
        payload: dict = Body(...), user: str = Depends(get_current_user)
    ):
        order_ids = [str(oid).strip() for oid in payload.get("order_ids", []) if str(oid).strip()]
        if not order_ids:
            raise HTTPException(status_code=400, detail="order_ids 필수")

        try:
            jwt_token = await pastelco_login()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        order_details = await fetch_order_details_realtime(order_ids, jwt_token, concurrency=10)

        conn = get_db()
        try:
            cost_rows = conn.execute(
                "SELECT product_name, cost_price FROM amood_product_costs"
            ).fetchall()
            cost_map = {r["product_name"]: r["cost_price"] for r in cost_rows}
        finally:
            conn.close()

        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM amood_settlement_settings WHERE key = 'per_item_cost'"
            ).fetchone()
            per_item_cost = int(row["value"]) if row else 1900
        finally:
            conn.close()

        if "per_item_cost" in payload:
            try:
                per_item_cost = int(payload["per_item_cost"])
            except (TypeError, ValueError):
                pass

        items, summary = aggregate_realtime_by_product(order_ids, order_details, cost_map, per_item_cost)
        return {"ok": True, "items": items, "summary": summary}

    return router
