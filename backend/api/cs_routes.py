from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException

from api.exchange_return_routes import ABLY_EMAIL, ABLY_PASSWORD
from api.inventory_dashboard_routes import (
    _EZADMIN_BASE,
    _EZADMIN_SESSION_KEY,
    _PAGE_ROWS,
    _build_par,
    _row_to_record,
    _to_int,
)
from barcode_core import normalize_to_s5
from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
from sdk.llogis import LLogisClient
from services import ezadmin_orders as ezo
from services import kakao_postcode
from services.cs_cost_match import CostBase, clean_name, option_key
from services.ezadmin_waiting_orders import DEFAULT_SELLER, parse_waiting_orders, popup_url, rank_order

ABLY_BASE = "https://api.a-bly.com"
_TOKEN_TTL_SEC = 50 * 60
_KST = timezone(timedelta(hours=9))
_INITIAL_SYNC_DAYS = 30
_MAX_PAGES = 100
_PREFETCH_LIMIT = 40
_PREFETCH_CONCURRENCY = 5
_BASE_TTL_SEC = 60
_EXCHANGE_TRANS_CORP = "30079"  # 이지어드민 CS창 상품교환 때 화면이 보낸 택배사 값 (교환뜨빠.har)


def build_cs_router(*, get_current_user, get_db, get_setting=None, normalize_code=None, allow_live_stock=True):
    router = APIRouter(prefix="/cs")
    token_cache: dict = {"token": None, "at": 0.0}
    http = httpx.AsyncClient(timeout=20.0)  # 연결 재사용으로 호출마다 TLS 핸드셰이크 생략
    base_cache: dict = {"at": 0.0, "base": None}

    def _cost_base() -> Optional[CostBase]:
        """DB관리 원가베이스유(wonbe)를 색인해 잠깐 캐시한다. 읽을 수 없으면 None."""
        if time.time() - base_cache["at"] < _BASE_TTL_SEC:
            return base_cache["base"]
        try:
            from api.wonbe_routes import load_wonbe_cost_base_df

            base = CostBase(load_wonbe_cost_base_df().to_dict("records"))
        except Exception:
            base = None
        base_cache.update(at=time.time(), base=base)
        return base

    def _username(user) -> str:
        return str(user.get("username", "")) if isinstance(user, dict) else str(user or "")

    def _headers(token: str) -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

    async def _login(client: httpx.AsyncClient) -> str:
        res = await client.post(
            f"{ABLY_BASE}/seller/login/",
            json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
            headers={
                "Content-Type": "application/json",
                "Origin": "https://seller-admin.a-bly.com",
                "Referer": "https://seller-admin.a-bly.com/",
                "User-Agent": "Mozilla/5.0",
            },
        )
        if res.status_code != 200:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        body = res.json()
        token = body.get("access_token") or body.get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        token_cache["token"] = token
        token_cache["at"] = time.time()
        return token

    async def _get_token(client: httpx.AsyncClient, force: bool = False) -> str:
        if force or not token_cache["token"] or time.time() - token_cache["at"] > _TOKEN_TTL_SEC:
            return await _login(client)
        return token_cache["token"]

    async def _ably_get(client: httpx.AsyncClient, path: str, params=None):
        token = await _get_token(client)
        res = await client.get(f"{ABLY_BASE}{path}", headers=_headers(token), params=params)
        if res.status_code in (401, 403):
            token = await _get_token(client, force=True)
            res = await client.get(f"{ABLY_BASE}{path}", headers=_headers(token), params=params)
        if res.status_code != 200:
            raise HTTPException(status_code=502, detail=f"에이블리 응답 오류({res.status_code})")
        return res.json()

    def _meta_get(conn, key: str) -> str:
        row = conn.execute("SELECT value FROM cs_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else ""

    def _meta_set(conn, key: str, value: str) -> None:
        conn.execute(
            "INSERT INTO cs_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _upsert_room(conn, room: dict) -> None:
        member = room.get("member") or {}
        latest = room.get("latest_message") or {}
        search_text = " ".join(
            str(x or "")
            for x in (
                member.get("name"),
                member.get("mobile"),
                member.get("email"),
                latest.get("content"),
                (room.get("order_item") or {}).get("order_sno"),
            )
        )
        conn.execute(
            """
            INSERT INTO cs_rooms (sno, updated_at, status, member_name, search_text, room_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(sno) DO UPDATE SET
                updated_at = excluded.updated_at,
                status = excluded.status,
                member_name = excluded.member_name,
                search_text = excluded.search_text,
                room_json = excluded.room_json
            """,
            (
                room["sno"],
                room.get("updated_latest_message_at") or "",
                int(room.get("status") or 0),
                member.get("name") or "",
                search_text,
                json.dumps(room, ensure_ascii=False),
            ),
        )

    async def _fetch_detail(sno: int) -> dict:
        async def _items():
            try:
                return await _ably_get(http, f"/seller/contact_rooms/{sno}/order_items/")
            except HTTPException:
                return {}

        detail, items = await asyncio.gather(
            _ably_get(http, f"/seller/contact_rooms/{sno}/"), _items()
        )
        detail["order_items"] = items.get("order_items", [])
        return detail

    def _store_detail(conn, sno: int, updated_at: str, detail: dict) -> None:
        conn.execute(
            "UPDATE cs_rooms SET detail_json = ?, detail_updated_at = ? WHERE sno = ?",
            (json.dumps(detail, ensure_ascii=False), updated_at, sno),
        )

    async def _prefetch_details() -> None:
        """상세가 없거나 오래된 최근 문의를 미리 받아 저장한다."""
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT sno, updated_at FROM cs_rooms WHERE detail_updated_at != updated_at "
                "ORDER BY updated_at DESC LIMIT ?",
                (_PREFETCH_LIMIT,),
            ).fetchall()
            targets = [(r["sno"], r["updated_at"]) for r in rows]
        finally:
            conn.close()
        sem = asyncio.Semaphore(_PREFETCH_CONCURRENCY)

        async def _one(sno: int, updated_at: str):
            async with sem:
                try:
                    detail = await _fetch_detail(sno)
                except Exception:
                    return None
            return sno, updated_at, detail

        results = [r for r in await asyncio.gather(*(_one(*t) for t in targets)) if r]
        if not results:
            return
        conn = get_db()
        try:
            for sno, updated_at, detail in results:
                _store_detail(conn, sno, updated_at, detail)
            conn.commit()
        finally:
            conn.close()

    @router.post("/sync")
    async def sync(current_user=Depends(get_current_user)):
        """에이블리에서 새로 생기거나 갱신된 문의만 가져와 저장한다."""
        conn = get_db()
        try:
            row = conn.execute("SELECT MAX(updated_at) AS m FROM cs_rooms").fetchone()
            watermark = (row["m"] if row else "") or ""
            now = datetime.now(_KST)
            if watermark:
                start = datetime.fromisoformat(watermark) - timedelta(days=1)
            else:
                start = now - timedelta(days=_INITIAL_SYNC_DAYS)
            params_base = [
                ("start_date", start.strftime("%Y-%m-%d")),
                ("end_date", now.strftime("%Y-%m-%d")),
                ("order", "-updated_latest_message_at"),
            ]
            fetched = 0
            last_sno = None
            for _ in range(_MAX_PAGES):
                params = list(params_base)
                if last_sno:
                    params.append(("last_sno", str(last_sno)))
                data = await _ably_get(http, "/seller/contact_rooms/", params)
                rooms = data.get("contact_rooms") or []
                for r in rooms:
                    _upsert_room(conn, r)
                fetched += len(rooms)
                last_sno = data.get("last_sno")
                if data.get("is_last") or not rooms or not last_sno:
                    break
                oldest = rooms[-1].get("updated_latest_message_at") or ""
                if watermark and oldest and oldest < watermark:
                    break
            _meta_set(conn, "last_sync_at", now.isoformat())
            conn.commit()
            total = conn.execute("SELECT COUNT(*) AS c FROM cs_rooms").fetchone()["c"]
        finally:
            conn.close()
        try:
            await _reconcile_open_rooms(now)
        except HTTPException:
            pass
        asyncio.create_task(_prefetch_details())
        return {"ok": True, "fetched": fetched, "total": total, "synced_at": now.isoformat()}

    @router.get("/rooms")
    def rooms(
        status: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        q: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
        current_user=Depends(get_current_user),
    ):
        where, args = [], []
        statuses = [int(s) for s in (status or "").split(",") if s.strip().isdigit()]
        if statuses:
            where.append(f"status IN ({','.join('?' * len(statuses))})")
            args += statuses
        if start_date:
            where.append("updated_at >= ?")
            args.append(start_date)
        if end_date:
            where.append("updated_at < ?")
            args.append((datetime.fromisoformat(end_date) + timedelta(days=1)).strftime("%Y-%m-%d"))
        if q and q.strip():
            where.append("search_text LIKE ?")
            args.append(f"%{q.strip()}%")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = max(1, min(limit, 500))
        conn = get_db()
        try:
            total = conn.execute(f"SELECT COUNT(*) AS c FROM cs_rooms {clause}", args).fetchone()["c"]
            rows = conn.execute(
                f"SELECT room_json FROM cs_rooms {clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                [*args, limit, max(0, offset)],
            ).fetchall()
            last_sync = _meta_get(conn, "last_sync_at")
        finally:
            conn.close()
        return {
            "contact_rooms": [json.loads(r["room_json"]) for r in rows],
            "total_count": total,
            "last_sync_at": last_sync,
        }

    @router.get("/rooms/{room_sno}")
    async def room_detail(room_sno: int, current_user=Depends(get_current_user)):
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT updated_at, detail_json, detail_updated_at FROM cs_rooms WHERE sno = ?",
                (room_sno,),
            ).fetchone()
            if row and row["detail_json"] and row["detail_updated_at"] == row["updated_at"]:
                return json.loads(row["detail_json"])
            detail = await _fetch_detail(room_sno)
            if row:
                _store_detail(conn, room_sno, row["updated_at"], detail)
                conn.commit()
            return detail
        finally:
            conn.close()

    async def _ably_post(client: httpx.AsyncClient, path: str, **kwargs):
        token = await _get_token(client)
        res = await client.post(f"{ABLY_BASE}{path}", headers=_headers(token), **kwargs)
        if res.status_code in (401, 403):
            token = await _get_token(client, force=True)
            res = await client.post(f"{ABLY_BASE}{path}", headers=_headers(token), **kwargs)
        if res.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"에이블리 요청 실패({res.status_code})")
        return res

    async def _refresh_room(sno: int) -> dict:
        """답변/완료 직후 에이블리의 최신 상태를 저장본에 반영하고 상세를 돌려준다."""
        detail = await _fetch_detail(sno)
        room = detail.get("contact_room") or {}
        conn = get_db()
        try:
            row = conn.execute("SELECT room_json FROM cs_rooms WHERE sno = ?", (sno,)).fetchone()
            if row:
                merged = json.loads(row["room_json"])
                for key in ("status", "get_status_display", "updated_latest_message_at", "latest_message"):
                    if key in room:
                        merged[key] = room[key]
                _upsert_room(conn, merged)
                _store_detail(conn, sno, merged.get("updated_latest_message_at") or "", detail)
                conn.commit()
        finally:
            conn.close()
        return detail

    async def _reconcile_open_rooms(now: datetime) -> None:
        """에이블리에서 이미 완료된 문의가 저장본에 '진행 중'으로 남지 않게 상태를 바로잡는다."""
        conn = get_db()
        try:
            rows = conn.execute("SELECT sno, updated_at FROM cs_rooms WHERE status IN (1, 2)").fetchall()
        finally:
            conn.close()
        if not rows:
            return
        oldest = min(r["updated_at"] for r in rows)[:10] or (now - timedelta(days=_INITIAL_SYNC_DAYS)).strftime("%Y-%m-%d")
        open_snos: set = set()
        last_sno = None
        for _ in range(_MAX_PAGES):
            params = [
                ("start_date", oldest), ("end_date", now.strftime("%Y-%m-%d")),
                ("order", "-updated_latest_message_at"), ("status[]", "1"), ("status[]", "2"),
            ]
            if last_sno:
                params.append(("last_sno", str(last_sno)))
            data = await _ably_get(http, "/seller/contact_rooms/", params)
            page = data.get("contact_rooms") or []
            open_snos.update(r["sno"] for r in page)
            last_sno = data.get("last_sno")
            if data.get("is_last") or not page or not last_sno:
                break
        else:
            return  # 끝까지 못 읽었으면 잘못 완료 처리하지 않도록 건너뛴다
        stale = [r["sno"] for r in rows if r["sno"] not in open_snos][:_PREFETCH_LIMIT]
        sem = asyncio.Semaphore(_PREFETCH_CONCURRENCY)

        async def _one(sno: int):
            async with sem:
                try:
                    await _refresh_room(sno)
                except Exception:
                    pass

        await asyncio.gather(*(_one(sno) for sno in stale))

    @router.get("/exchange/{order_sno}")
    async def exchange_options(order_sno: int, current_user=Depends(get_current_user)):
        """주문번호의 교환 신청에서 원래 옵션 → 교환 옵션을 상품별로 돌려준다."""
        now = datetime.now(_KST)
        data = await _ably_get(http, "/seller/exchanges/", {
            "page": 1, "per_page": 30,
            "requested_at_start": (now - timedelta(days=365)).strftime("%Y-%m-%d 00:00:00"),
            "requested_at_end": now.strftime("%Y-%m-%d 23:59:59"),
            "keyword_type": "order_sno", "keyword": str(order_sno),
        })
        items = []
        for ex in data.get("exchanges") or []:
            for it in ex.get("exchange_items") or []:
                order_item = it.get("order_item") or {}
                original = order_item.get("original_goods_option") or {}
                exchange = it.get("exchange_goods_option") or {}
                items.append({
                    "exchange_sno": ex.get("exchange_sno"),
                    "exchange_status": ex.get("exchange_status"),
                    "status": order_item.get("status") or "",
                    "goods_sno": order_item.get("goods_sno"),
                    "goods_name": order_item.get("goods_name") or "",
                    "quantity": order_item.get("quantity") or 1,
                    "original_options": original.get("option_values") or [],
                    "original_option_no": original.get("sno"),
                    "exchange_options": exchange.get("option_values") or [],
                    "exchange_option_no": exchange.get("sno"),
                })
        return {"order_sno": order_sno, "items": items}

    @router.post("/rooms/{room_sno}/reply")
    async def reply(room_sno: int, payload: dict = Body(...), current_user=Depends(get_current_user)):
        """에이블리 문의에 답변을 보낸다."""
        content = str(payload.get("content") or "").strip()
        if not content:
            raise HTTPException(status_code=400, detail="답변 내용을 입력하세요.")
        await _ably_post(http, f"/seller/contact_rooms/{room_sno}/send/", files={"content": (None, content)})
        return {"ok": True, "detail": await _refresh_room(room_sno)}

    @router.post("/rooms/{room_sno}/complete")
    async def complete(room_sno: int, current_user=Depends(get_current_user)):
        """에이블리 문의를 답변 완료 처리한다."""
        await _ably_post(http, f"/seller/contact_rooms/{room_sno}/complete/")
        return {"ok": True, "detail": await _refresh_room(room_sno)}

    @router.get("/dashboard")
    def dashboard(
        days: int = 14,
        product_limit: int = 6,
        room_limit: int = 0,
        with_match: bool = False,
        current_user=Depends(get_current_user),
    ):
        """저장된 문의 기준 요약 통계. 에이블리를 호출하지 않는다."""
        days = max(1, min(days, 60))
        now = datetime.now(_KST).replace(tzinfo=None)
        today = now.date()
        since = (today - timedelta(days=days - 1)).isoformat()
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT room_json FROM cs_rooms WHERE updated_at >= ? OR status IN (1, 2)",
                (since,),
            ).fetchall()
            last_sync = _meta_get(conn, "last_sync_at")
        finally:
            conn.close()

        daily = {(today - timedelta(days=i)).isoformat(): 0 for i in range(days - 1, -1, -1)}
        by_category: dict[str, dict] = {}
        waiting_rooms = []
        products: dict[int, dict] = {}
        in_progress = 0
        for r in rows:
            room = json.loads(r["room_json"])
            created = (room.get("created_at") or "")[:10]
            if created in daily:
                daily[created] += 1
            if int(room.get("status") or 0) not in (1, 2):
                continue
            in_progress += 1
            name = room.get("parent_category_display") or "기타"
            cat = by_category.setdefault(name, {"name": name, "count": 0, "waiting": 0})
            cat["count"] += 1
            is_waiting = (room.get("latest_message") or {}).get("member_type") == "USER"
            if is_waiting:
                cat["waiting"] += 1
                waiting_rooms.append(room)
            goods = room.get("goods") or (room.get("order_item") or {}).get("goods") or {}
            if goods.get("sno"):
                prod = products.setdefault(
                    goods["sno"],
                    {
                        "goods_sno": goods["sno"],
                        "name": goods.get("name") or "",
                        "image": goods.get("image_still") or goods.get("image") or "",
                        "count": 0,
                        "waiting": 0,
                        "topics": {},
                        "rooms": [],
                    },
                )
                prod["count"] += 1
                prod["waiting"] += 1 if is_waiting else 0
                topic = room.get("child_category_display") or "기타"
                prod["topics"][topic] = prod["topics"].get(topic, 0) + 1
                member = room.get("member") or {}
                latest = room.get("latest_message") or {}
                prod["rooms"].append(
                    {
                        "sno": room["sno"],
                        "updated_latest_message_at": room.get("updated_latest_message_at"),
                        "member": {k: member.get(k) for k in ("name", "mobile", "email")},
                        "parent_category_display": room.get("parent_category_display"),
                        "child_category_display": room.get("child_category_display"),
                        "get_status_display": room.get("get_status_display"),
                        "latest_message": {
                            "content": latest.get("content"),
                            "member_type": latest.get("member_type"),
                        },
                        "waiting": is_waiting,
                        "options": list((room.get("order_item") or {}).get("options") or []),
                        "goods_option_sno": (room.get("order_item") or {}).get("goods_option_sno"),
                        "order_sno": (room.get("order_item") or {}).get("order_sno"),
                    }
                )

        def _age_hours(room) -> float:
            try:
                ts = datetime.fromisoformat(room.get("updated_latest_message_at") or "")
                return max(0.0, (now - ts).total_seconds() / 3600)
            except ValueError:
                return 0.0

        waiting_rooms.sort(key=lambda x: x.get("updated_latest_message_at") or "")
        oldest = [
            {**room, "waiting_hours": round(_age_hours(room), 1)} for room in waiting_rooms[:10]
        ]
        by_product = sorted(products.values(), key=lambda x: (-x["count"], -x["waiting"]))[: max(0, min(product_limit, 300))]
        for prod in by_product:
            prod["topics"] = [
                {"name": k, "count": v}
                for k, v in sorted(prod["topics"].items(), key=lambda kv: -kv[1])
            ]
            prod["rooms"].sort(key=lambda x: x["updated_latest_message_at"] or "", reverse=True)
            prod["rooms"].sort(key=lambda x: not x["waiting"])  # 대기 중인 문의를 위로 (안정 정렬)
            prod["rooms"] = prod["rooms"][: max(0, min(room_limit, 200))]
            prod["clean_name"] = clean_name(prod["name"])
        base_available = None
        if with_match:
            base = _cost_base()
            base_available = base is not None
            conn = get_db()
            try:
                product_links = {
                    r["goods_sno"]: r["base_name"]
                    for r in conn.execute("SELECT goods_sno, base_name FROM cs_product_links").fetchall()
                }
                option_links = {
                    (r["goods_sno"], r["option_key"]): r["base_code"]
                    for r in conn.execute("SELECT goods_sno, option_key, base_code FROM cs_option_links").fetchall()
                }
            finally:
                conn.close()
            for prod in by_product:
                rows = []
                prod["match"] = None
                if base is not None:
                    method, rows = base.product_rows(prod["goods_sno"], prod["name"], product_links.get(prod["goods_sno"], ""))
                    if method:
                        prod["match"] = {"method": method, **base.summarize(rows)}
                for r in prod["rooms"]:
                    r["option_label"] = " / ".join(str(o) for o in r["options"])
                    r["option_key"] = option_key(r["options"])
                    r["option_match"] = None
                    if rows and r["options"]:
                        method, row = base.match_option(
                            rows, r["options"], r["goods_option_sno"], option_links.get((prod["goods_sno"], r["option_key"]), "")
                        )
                        if row:
                            r["option_match"] = {"method": method, **base.option_info(row)}
        today_key, yesterday_key = today.isoformat(), (today - timedelta(days=1)).isoformat()
        return {
            "in_progress": in_progress,
            "waiting": len(waiting_rooms),
            "waiting_over_24h": sum(1 for x in waiting_rooms if _age_hours(x) >= 24),
            "today_new": daily.get(today_key, 0),
            "yesterday_new": daily.get(yesterday_key, 0),
            "daily": [{"date": d, "count": c} for d, c in daily.items()],
            "by_category": sorted(by_category.values(), key=lambda x: -x["count"]),
            "oldest_waiting": oldest,
            "by_product": by_product,
            "base_available": base_available,
            "last_sync_at": last_sync,
        }

    async def _ezadmin_stock_by_name(phpsessid: str, base_name: str, fetched_at: str) -> dict:
        """이지어드민 재고(I100)를 상품명으로 검색해 {상품코드: 재고 레코드}로 돌려준다."""
        normalize = normalize_code or (lambda value: value)
        par = _build_par(fetched_at[:10]).replace("query_type=name&query_str=", f"query_type=name&query_str={quote(base_name)}")
        found: dict = {}
        async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
            page, total_pages = 1, 1
            while page <= total_pages and page <= 20:
                res = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data={
                        "_search": "false", "nd": str(int(time.time() * 1000)),
                        "rows": str(_PAGE_ROWS), "page": str(page), "sidx": "", "sord": "asc",
                        "template": "I100", "action": "search", "page_code": "I100", "par": par,
                    },
                    cookies={"PHPSESSID": phpsessid},
                    headers={
                        "User-Agent": "Mozilla/5.0",
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": f"{_EZADMIN_BASE}/template35.htm?template=I100",
                    },
                )
                try:
                    obj = res.json()
                except Exception:
                    raise PermissionError("이지어드민 세션이 만료되었습니다.")
                if not isinstance(obj, dict) or "rows" not in obj:
                    raise RuntimeError("이지어드민 응답 형식이 달라요.")
                for row in obj["rows"]:
                    rec = _row_to_record(row.get("cell") or {}, normalize, fetched_at)
                    if rec:
                        found[normalize_to_s5(rec[0]) or rec[0]] = {
                            "stock_qty": rec[6], "before_trans": rec[7], "stock_in_standby": rec[8], "trans_ready": rec[9],
                        }
                total_pages = _to_int(obj.get("total")) or 1
                page += 1
        return found

    def _stock_snapshot(codes: list[str]) -> tuple[dict, str]:
        """재고대시보드가 저장해 둔 이지어드민 재고에서 상품코드로 찾는다."""
        if not codes:
            return {}, ""
        # 재고 테이블은 YUSAS##### 형식, 원가베이스는 S##### 형식이라 둘 다로 찾는다.
        variants = list(dict.fromkeys(codes + ["YUSAS" + c[1:] for c in codes if c[:1].upper() == "S"]))
        conn = get_db()
        try:
            marks = ",".join("?" * len(variants))
            rows = conn.execute(
                f"SELECT code, stock_qty, before_trans, stock_in_standby, trans_ready, fetched_at "
                f"FROM inventory_dashboard_stock WHERE code IN ({marks})",
                variants,
            ).fetchall()
        except Exception:
            return {}, ""
        finally:
            conn.close()
        found = {
            (normalize_to_s5(r["code"]) or r["code"]): {
                "stock_qty": r["stock_qty"], "before_trans": r["before_trans"],
                "stock_in_standby": r["stock_in_standby"], "trans_ready": r["trans_ready"],
            }
            for r in rows
        }
        return found, (rows[0]["fetched_at"] if rows else "")

    def _attach_inbound(result: dict) -> dict:
        """재고 결과의 각 옵션에 입고 일정(+업데이트 시각)을 붙인다. 캐시에는 저장하지 않고 항상 최신으로 읽는다."""
        codes = [o["code"] for o in result.get("options", []) if o.get("code")]
        found: dict = {}
        if codes:
            conn = get_db()
            try:
                marks = ",".join("?" * len(codes))
                for r in conn.execute(
                    f"SELECT code, expected_date, note, updated_by, updated_at FROM cs_inbound_schedules WHERE code IN ({marks})",
                    codes,
                ).fetchall():
                    found[r["code"]] = {k: r[k] for k in ("expected_date", "note", "updated_by", "updated_at")}
            finally:
                conn.close()
        for o in result.get("options", []):
            o["inbound"] = found.get(o.get("code"))
        return result

    @router.put("/inbound")
    def set_inbound(body: dict = Body(...), current_user=Depends(get_current_user)):
        """옵션(들)의 입고 일정을 저장한다. 날짜와 메모가 모두 비어 있으면 삭제."""
        codes = body.get("codes") if isinstance(body.get("codes"), list) else [body.get("code")]
        codes = [str(c).strip() for c in codes if str(c or "").strip()]
        if not codes or len(codes) > 300:
            raise HTTPException(status_code=400, detail="옵션 코드를 1~300개 지정해 주세요.")
        expected = str(body.get("expected_date") or "").strip()
        note = str(body.get("note") or "").strip()
        if expected:
            try:
                datetime.strptime(expected, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="입고 날짜는 YYYY-MM-DD 형식이어야 해요.")
        if len(note) > 200:
            raise HTTPException(status_code=400, detail="메모는 200자 이내로 적어 주세요.")
        base = _cost_base()
        if base is not None and any(c not in base.by_code for c in codes):
            raise HTTPException(status_code=400, detail="원가베이스에 없는 옵션 코드가 있어요.")
        now = datetime.now(_KST).isoformat()
        conn = get_db()
        try:
            for code in codes:
                if expected or note:
                    conn.execute(
                        "INSERT INTO cs_inbound_schedules (code, expected_date, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) "
                        "ON CONFLICT(code) DO UPDATE SET expected_date = excluded.expected_date, note = excluded.note, "
                        "updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                        (code, expected, note, _username(current_user), now),
                    )
                else:
                    conn.execute("DELETE FROM cs_inbound_schedules WHERE code = ?", (code,))
            conn.commit()
        finally:
            conn.close()
        saved = None if not (expected or note) else {
            "expected_date": expected, "note": note, "updated_by": _username(current_user), "updated_at": now,
        }
        return {"ok": True, "codes": codes, "inbound": saved}

    @router.post("/order-rank")
    async def order_rank(body: dict = Body(...), current_user=Depends(get_current_user)):
        """문의 주문이 해당 옵션 대기 주문(이지어드민 I104) 중 에이블리(유색) 기준 몇 번째인지 계산한다."""
        try:
            goods_sno = int(body["goods_sno"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="goods_sno가 필요합니다.")
        order_no = str(body.get("order_no") or "").strip()
        options = [str(o) for o in (body.get("options") or [])]
        if not order_no:
            raise HTTPException(status_code=400, detail="이 문의의 주문번호를 찾지 못했어요.")
        base = _cost_base()
        if base is None:
            raise HTTPException(status_code=503, detail="원가베이스를 읽을 수 없어 옵션을 찾을 수 없어요.")
        conn = get_db()
        try:
            link = conn.execute("SELECT base_name FROM cs_product_links WHERE goods_sno = ?", (goods_sno,)).fetchone()
            opt_link = conn.execute(
                "SELECT base_code FROM cs_option_links WHERE goods_sno = ? AND option_key = ?",
                (goods_sno, option_key(options)),
            ).fetchone()
        finally:
            conn.close()
        _, rows = base.product_rows(goods_sno, str(body.get("name") or ""), link["base_name"] if link else "")
        if not rows:
            raise HTTPException(status_code=404, detail="원가베이스에 매칭된 상품이 아니에요. 먼저 상품을 연결해 주세요.")
        _, row = base.match_option(rows, options, body.get("goods_option_sno"), opt_link["base_code"] if opt_link else "")
        if not row:
            raise HTTPException(status_code=404, detail="문의한 옵션을 원가베이스에서 찾지 못했어요. 옵션을 먼저 연결해 주세요.")
        info = base.option_info(row)

        if not allow_live_stock:
            raise HTTPException(status_code=403, detail="이 서버에서는 이지어드민을 조회할 수 없어요. 로컬에서 확인해 주세요.")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip() if get_setting else ""
        if not phpsessid:
            raise HTTPException(status_code=400, detail="EZAdmin 세션이 없어요. 상단 EZAdmin 설정에서 세션을 등록해 주세요.")
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                res = await client.get(
                    popup_url(info["code"]),
                    cookies={"PHPSESSID": phpsessid},
                    headers={"User-Agent": "Mozilla/5.0", "Referer": f"{_EZADMIN_BASE}/template35.htm?template=I100"},
                )
            waiting = parse_waiting_orders(res.text)
        except ValueError as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {e}")

        return {
            "ok": True,
            "option": info,
            "stock": waiting["stock"],
            "fetched_at": datetime.now(_KST).isoformat(),
            "default_seller": DEFAULT_SELLER,
            **rank_order(waiting["orders"], order_no),
        }

    def _ezadmin_session() -> str:
        if not allow_live_stock:
            raise HTTPException(status_code=403, detail="이 서버에서는 이지어드민을 조회할 수 없어요. 로컬에서 확인해 주세요.")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip() if get_setting else ""
        if not phpsessid:
            raise HTTPException(status_code=400, detail="EZAdmin 세션이 없어요. 상단 EZAdmin 설정에서 세션을 등록해 주세요.")
        return phpsessid

    @router.post("/address/search")
    async def address_search(body: dict = Body(...), current_user=Depends(get_current_user)):
        """주문번호로 이지어드민 합포를 검색한다. 여러 건이면 모두 돌려주고 화면에서 고른다."""
        keyword = str(body.get("order_no") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9\-]{6,40}", keyword):
            raise HTTPException(status_code=400, detail="주문번호를 정확히 입력해 주세요. (영문·숫자 6자 이상)")
        phpsessid = _ezadmin_session()
        try:
            cells = await ezo.search_packs(phpsessid, keyword, days=int(body.get("days") or 90))
            cells = cells[:10]
            details = await asyncio.gather(*(ezo.pack_rows(phpsessid, c["pack"]) for c in cells))
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {e}")
        packs = [ezo.describe_pack(c["pack"], c, rows, keyword) for c, rows in zip(cells, details)]
        packs.sort(key=lambda p: (not p["exact"], p["collect_date"]), reverse=False)
        return {"ok": True, "order_no": keyword, "packs": packs}

    @router.post("/delivery/search")
    async def delivery_search(body: dict = Body(...), current_user=Depends(get_current_user)):
        """전화번호로 이지어드민 주문(합포)을 검색해 송장번호까지 돌려준다. 여러 건이면 화면에서 고른다."""
        digits = re.sub(r"\D", "", str(body.get("phone") or ""))
        if not re.fullmatch(r"01\d{8,9}", digits):
            raise HTTPException(status_code=400, detail="휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)")
        # 이지어드민에는 하이픈이 있는 형태로 저장돼 있다 (010-1234-5678).
        keyword = f"{digits[:3]}-{digits[3:-4]}-{digits[-4:]}"
        phpsessid = _ezadmin_session()
        try:
            cells = await ezo.search_packs(phpsessid, keyword, days=int(body.get("days") or 30), rows=20, search_type="6")
            cells = cells[:10]
            details = await asyncio.gather(*(ezo.pack_rows(phpsessid, c["pack"]) for c in cells))
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {e}")
        packs = [ezo.describe_pack(c["pack"], c, rows, "") for c, rows in zip(cells, details)]
        packs.sort(key=lambda p: p["collect_date"], reverse=True)
        return {"ok": True, "phone": keyword, "packs": packs}

    @router.post("/history")
    async def pack_history(body: dict = Body(...), current_user=Depends(get_current_user)):
        """합포의 이지어드민 C/S 이력."""
        pack = str(body.get("pack") or "").strip()
        if not re.fullmatch(r"\d{1,12}", pack):
            raise HTTPException(status_code=400, detail="합포 번호가 올바르지 않아요.")
        phpsessid = _ezadmin_session()
        try:
            history = await ezo.cs_history(phpsessid, pack)
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {e}")
        return {"ok": True, "pack": pack, "history": history}

    @router.post("/hold/release")
    async def hold_release(body: dict = Body(...), current_user=Depends(get_current_user)):
        """합포의 보류를 풀고 정상 상태로 되돌린다. 지금 상태를 다시 읽어 필요한 단계만 실행한다."""
        pack = str(body.get("pack") or "").strip()
        if not re.fullmatch(r"\d{1,12}", pack):
            raise HTTPException(status_code=400, detail="합포 번호가 올바르지 않아요.")
        phpsessid = _ezadmin_session()

        async def current_state() -> dict:
            rows = await ezo.pack_rows(phpsessid, pack)
            if not rows:
                raise HTTPException(status_code=404, detail="합포를 찾지 못했어요. 다시 검색해 주세요.")
            order_id = str(rows[0]["row"].get("order_id", ""))
            cell = next((c for c in await ezo.search_packs(phpsessid, order_id) if str(c.get("pack")) == pack), None)
            if cell is None:
                raise HTTPException(status_code=404, detail="합포의 현재 상태를 읽지 못했어요. 다시 검색해 주세요.")
            return {"hold": str(cell.get("hold", "") or "0"), "order_cs": str(cell.get("order_cs", "") or "0")}

        def ok(result) -> bool:
            return isinstance(result, dict) and str(result.get("error", "")) in ("0", "")

        done: list[str] = []
        try:
            before = await current_state()
            needs_cs = before["order_cs"].split(",")[0] != "0"
            if before["hold"] == "0" and not needs_cs:
                raise HTTPException(status_code=409, detail="이미 보류가 아닌 정상 주문이에요.")
            if needs_cs and not body.get("allow_cancelled"):
                raise HTTPException(status_code=409, detail="취소·CS 상태의 주문이에요. 확인 후 다시 진행해 주세요.")
            if before["hold"] != "0":
                result = await ezo.release_hold(phpsessid, pack)
                if not ok(result):
                    raise HTTPException(status_code=502, detail=f"이지어드민이 보류 해제를 거부했어요. ({result})")
                done.append("보류 해제")
            if needs_cs:
                result = await ezo.normal_pack(phpsessid, pack)
                if not ok(result):
                    raise HTTPException(
                        status_code=502,
                        detail=f"{'보류 해제는 끝났지만 ' if done else ''}정상 복귀를 이지어드민이 거부했어요. ({result})",
                    )
                done.append("정상 복귀")
            after = await current_state()
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {e}")
        return {"ok": True, "done": done, "before": before, "after": after}

    @router.post("/exchange/options")
    async def exchange_options(body: dict = Body(...), current_user=Depends(get_current_user)):
        """교환할 상품의 옵션 목록 (이지어드민 상품교환 팝업 검색과 같다)."""
        name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
        shop_id = str(body.get("shop_id") or "").strip()
        if not name or not re.fullmatch(r"\d{1,10}", shop_id):
            raise HTTPException(status_code=400, detail="상품명과 쇼핑몰 정보가 필요합니다.")
        phpsessid = _ezadmin_session()
        try:
            options = await ezo.search_products(phpsessid, name, shop_id)
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 조회 실패: {e}")
        return {"ok": True, "options": options}

    @router.post("/exchange/change")
    async def exchange_change(body: dict = Body(...), current_user=Depends(get_current_user)):
        """합포의 주문상품 한 줄을 다른 옵션(상품코드)으로 교환 처리한다 (이지어드민 change_product)."""
        pack = str(body.get("pack") or "").strip()
        prd_seq = str(body.get("prd_seq") or "").strip()
        old_id = str(body.get("old_product_id") or "").strip()
        new_id = str(body.get("new_product_id") or "").strip()
        reason = str(body.get("reason") or "").strip()[:200]
        try:
            qty = int(body.get("qty") or 1)
        except (TypeError, ValueError):
            qty = 0
        if not (re.fullmatch(r"\d{1,12}", pack) and re.fullmatch(r"\d{1,12}", prd_seq) and old_id and new_id):
            raise HTTPException(status_code=400, detail="교환할 주문상품 정보가 올바르지 않아요.")
        if old_id == new_id:
            raise HTTPException(status_code=400, detail="같은 옵션으로는 교환할 수 없어요.")
        phpsessid = _ezadmin_session()
        try:
            rows = await ezo.pack_rows(phpsessid, pack)
            line = next((r for r in rows if str(r["row"].get("prd_seq", "")) == prd_seq), None)
            # 검색 이후 다른 곳에서 바뀌었다면 처리하지 않는다.
            if line is None or str(line["row"].get("product_id", "")) != old_id:
                raise HTTPException(status_code=409, detail="그 사이 주문상품이 바뀌었어요. 다시 검색해서 확인해 주세요.")
            if line["row"].get("trans_no") and not body.get("allow_shipped"):
                raise HTTPException(status_code=409, detail="이미 송장이 발행된 주문이에요. 확인 후 다시 진행해 주세요.")
            ordered = int(line["row"].get("qty") or 1)
            if not 1 <= qty <= ordered:
                raise HTTPException(status_code=400, detail=f"교환 수량은 1~{ordered}개여야 해요.")
            # 새 옵션 이름은 클라이언트 값을 믿지 않고 이지어드민 검색 결과에서 가져온다.
            candidates = await ezo.search_products(phpsessid, str(line["row"].get("product_name") or ""), str(line["row"].get("shop_id") or ""))
            target = next((c for c in candidates if c["product_id"] == new_id), None)
            if target is None:
                raise HTTPException(status_code=400, detail="선택한 옵션을 이 상품의 옵션 목록에서 찾지 못했어요.")
            result = await EzAdminClient(get_setting).change_product(
                pack, prd_seq, product_id=new_id, old_product_id=old_id, options=target["options"],
                qty=qty, trans_corp=_EXCHANGE_TRANS_CORP, reason=reason,
            )
            if not isinstance(result, dict) or str(result.get("error", "")) not in ("0", ""):
                raise HTTPException(status_code=502, detail=f"이지어드민이 교환 처리를 거부했어요. ({result})")
            after = await ezo.pack_rows(phpsessid, pack)
        except (ezo.SessionExpired, EzAdminSessionExpired) as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {e}")
        verified = any(str(r["row"].get("product_id", "")) == new_id for r in after)
        return {"ok": True, "verified": verified, "new_options": target["options"], "qty": qty}

    @router.post("/delivery/track")
    async def delivery_track(body: dict = Body(...), current_user=Depends(get_current_user)):
        """송장번호로 롯데택배(llogis) 배송 상태와 이동 이력을 바로 조회한다."""
        invoice = re.sub(r"\D", "", str(body.get("invoice") or ""))
        if not invoice:
            raise HTTPException(status_code=400, detail="송장번호가 필요합니다.")
        try:
            raw = await LLogisClient().query_raw(invoice)
        except (httpx.HTTPError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=f"롯데택배 조회 실패: {e}")
        info = (raw.get("invInfoList") or [{}])[0]
        moves = raw.get("mvmList") or []
        if not info and not moves:
            return {"ok": True, "found": False, "invoice": invoice}
        # mvmList 는 시간순이 아닐 수 있어 스캔일시 기준으로 최신순 정렬한다.
        history = sorted(moves, key=lambda m: re.sub(r"\D", "", str(m.get("rgstYmd") or "")).ljust(14, "0"), reverse=True)
        history = [
            {"status": m.get("paclStatNm") or "-", "location": m.get("scanBrshNm") or "-", "scan_date": m.get("rgstYmd") or ""}
            for m in history
        ]
        return {
            "ok": True,
            "found": True,
            "invoice": invoice,
            "receiver": info.get("acperNm") or "",
            "product": info.get("artcNm") or "",
            "sent_date": info.get("acptRgstYmd") or "",
            "delivered_date": info.get("dlvYmd") or "",
            "latest": history[0] if history else None,
            "history": history,
        }

    @router.get("/address/lookup")
    def address_lookup(q: str = "", current_user=Depends(get_current_user)):
        """카카오 우편번호로 주소를 검색한다 (이지어드민 주소 검색 팝업과 같은 소스)."""
        if len(q.strip()) < 2:
            raise HTTPException(status_code=400, detail="검색어를 두 글자 이상 입력해 주세요.")
        try:
            return {"ok": True, **kakao_postcode.search(q)}
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"주소 검색에 실패했어요: {e}")

    @router.post("/address/change")
    async def address_change(body: dict = Body(...), current_user=Depends(get_current_user)):
        """이지어드민 합포의 배송지(주소·우편번호)만 바꾼다. 나머지 값은 현재 값을 그대로 유지한다."""
        pack = str(body.get("pack") or "").strip()
        address = re.sub(r"\s+", " ", str(body.get("address") or "")).strip()
        zip_code = str(body.get("zip") or "").strip()
        if not re.fullmatch(r"\d{1,12}", pack):
            raise HTTPException(status_code=400, detail="합포 번호가 올바르지 않아요.")
        if not address or len(address) > 200:
            raise HTTPException(status_code=400, detail="주소를 1~200자로 입력해 주세요.")
        if not re.fullmatch(r"\d{5}", zip_code):
            raise HTTPException(status_code=400, detail="우편번호(5자리)를 확인해 주세요.")
        phpsessid = _ezadmin_session()
        try:
            rows = await ezo.pack_rows(phpsessid, pack)
            if not rows:
                raise HTTPException(status_code=404, detail="합포를 찾지 못했어요. 다시 검색해 주세요.")
            data = rows[0]["row"]
            # 검색 이후 다른 곳에서 주소가 바뀌었다면 덮어쓰지 않는다.
            expected = body.get("expected_address")
            if expected is not None and (str(expected).strip() != str(data.get("recv_add", "")).strip()
                                         or str(body.get("expected_zip") or "").strip() != str(data.get("recv_zip", "")).strip()):
                raise HTTPException(status_code=409, detail="그 사이 주소가 바뀌었어요. 다시 검색해서 확인해 주세요.")
            if data.get("trans_no") and not body.get("allow_shipped"):
                raise HTTPException(status_code=409, detail="이미 송장이 발행된 주문이에요. 확인 후 다시 진행해 주세요.")
            result = await ezo.change_address(phpsessid, data, address, zip_code, pack)
            if not isinstance(result, dict) or str(result.get("error", "")) not in ("0", ""):
                raise HTTPException(status_code=502, detail=f"이지어드민이 변경을 거부했어요. ({result})")
            after_rows = await ezo.pack_rows(phpsessid, pack)
        except ezo.SessionExpired as e:
            raise HTTPException(status_code=401, detail=f"{e} 상단 EZAdmin 설정에서 세션을 갱신해 주세요.")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {e}")

        after = after_rows[0]["row"] if after_rows else {}
        verified = str(after.get("recv_add", "")).strip() == address and str(after.get("recv_zip", "")).strip() == zip_code
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO cs_address_changes (pack, order_id, shop_name, old_address, old_zip, new_address, new_zip, verified, changed_by, changed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    pack, str(data.get("order_id", "")), str(data.get("shop_name", "")),
                    str(data.get("recv_add", "")), str(data.get("recv_zip", "")), address, zip_code,
                    1 if verified else 0, _username(current_user), datetime.now(_KST).isoformat(),
                ),
            )
            conn.commit()
        finally:
            conn.close()
        return {
            "ok": True,
            "verified": verified,
            "before": {"address": data.get("recv_add", ""), "zip": data.get("recv_zip", "")},
            "after": {"address": after.get("recv_add", ""), "zip": after.get("recv_zip", "")},
        }

    @router.post("/stock/lookup")
    async def stock_lookup(body: dict = Body(...), current_user=Depends(get_current_user)):
        """상품의 모든 옵션 재고를 수집한다. 원가베이스에 매칭된 상품만 조회할 수 있다."""
        try:
            goods_sno = int(body["goods_sno"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="goods_sno가 필요합니다.")
        name = str(body.get("name") or "")
        base = _cost_base()
        if base is None:
            raise HTTPException(status_code=503, detail="원가베이스를 읽을 수 없어 재고를 조회할 수 없어요.")
        conn = get_db()
        try:
            link = conn.execute("SELECT base_name FROM cs_product_links WHERE goods_sno = ?", (goods_sno,)).fetchone()
        finally:
            conn.close()
        _, rows = base.product_rows(goods_sno, name, link["base_name"] if link else "")
        if not rows:
            raise HTTPException(status_code=404, detail="원가베이스에 매칭된 상품이 아니에요. 먼저 상품을 연결해 주세요.")

        base_name = base.summarize(rows)["base_name"]
        codes = [str(r.get("상품코드") or "").strip() for r in rows if str(r.get("상품코드") or "").strip()]
        now = datetime.now(_KST)
        source, note, fetched_at, stock = "", "", now.isoformat(), {}

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip() if get_setting else ""
        if allow_live_stock and phpsessid:
            try:
                stock = await _ezadmin_stock_by_name(phpsessid, base_name, fetched_at)
                source = "live"
            except PermissionError as e:
                note = f"{e} 상단 EZAdmin 설정에서 세션을 갱신하면 실시간으로 조회돼요. 저장된 재고로 대신 보여드려요."
            except Exception as e:  # 네트워크/형식 오류는 저장본으로 대체
                note = f"이지어드민 조회에 실패해 저장된 재고로 대신 보여드려요. ({e})"
        elif not allow_live_stock:
            note = "이 서버에서는 실시간 조회가 막혀 있어 저장된 재고를 보여드려요."
        else:
            note = "EZAdmin 세션이 없어 저장된 재고를 보여드려요. 상단 EZAdmin 설정에서 세션을 등록해 주세요."
        if not source:
            stock, snap_at = _stock_snapshot(codes)
            source = "snapshot" if snap_at else "none"
            fetched_at = snap_at or fetched_at

        options = []
        for row in rows:
            info = base.option_info(row)
            qty = stock.get(info["code"])
            options.append(
                {
                    **info,
                    "found": qty is not None,
                    "stock_qty": qty["stock_qty"] if qty else 0,
                    "stock_in_standby": qty["stock_in_standby"] if qty else 0,
                    "before_trans": qty["before_trans"] if qty else 0,
                    "trans_ready": qty["trans_ready"] if qty else 0,
                }
            )
        result = {
            "ok": True,
            "source": source,
            "note": note,
            "fetched_at": fetched_at,
            "base_name": base_name,
            "total_stock": sum(o["stock_qty"] for o in options),
            "options": options,
        }
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO cs_stock_cache (goods_sno, fetched_at, result_json) VALUES (?, ?, ?) "
                "ON CONFLICT(goods_sno) DO UPDATE SET fetched_at = excluded.fetched_at, result_json = excluded.result_json",
                (goods_sno, fetched_at, json.dumps(result, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()
        return _attach_inbound(result)

    @router.get("/stock/{goods_sno}")
    def stock_cached(goods_sno: int, current_user=Depends(get_current_user)):
        """마지막으로 조회한 재고 결과 (없으면 result=null)."""
        conn = get_db()
        try:
            row = conn.execute("SELECT result_json FROM cs_stock_cache WHERE goods_sno = ?", (goods_sno,)).fetchone()
        finally:
            conn.close()
        return {"result": _attach_inbound(json.loads(row["result_json"])) if row else None}

    @router.get("/cost-base/search")
    def cost_base_search(q: str = "", current_user=Depends(get_current_user)):
        base = _cost_base()
        if base is None:
            return {"base_available": False, "products": []}
        return {"base_available": True, "products": base.search_products(q)}

    @router.get("/products/{goods_sno}/base-options")
    def product_base_options(goods_sno: int, name: str = "", current_user=Depends(get_current_user)):
        """현재 매칭된(또는 이름이 같은) 원가베이스 상품의 옵션 행들 — 옵션 수동 연결용."""
        base = _cost_base()
        if base is None:
            return {"base_available": False, "options": []}
        conn = get_db()
        try:
            row = conn.execute("SELECT base_name FROM cs_product_links WHERE goods_sno = ?", (goods_sno,)).fetchone()
        finally:
            conn.close()
        _, rows = base.product_rows(goods_sno, name, row["base_name"] if row else "")
        # 옵션별 입고 일정(업데이트 시각 포함)도 함께 내려준다.
        return _attach_inbound({"base_available": True, "options": [base.option_info(r) for r in rows]})

    @router.put("/links/product")
    def link_product(body: dict = Body(...), current_user=Depends(get_current_user)):
        try:
            goods_sno = int(body["goods_sno"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="goods_sno가 필요합니다.")
        base_name = str(body.get("base_name") or "").strip()
        base = _cost_base()
        if not base_name or (base is not None and base_name not in base.by_name):
            raise HTTPException(status_code=400, detail="원가베이스에 없는 상품명입니다.")
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO cs_product_links (goods_sno, base_name, linked_by, linked_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(goods_sno) DO UPDATE SET base_name = excluded.base_name, "
                "linked_by = excluded.linked_by, linked_at = excluded.linked_at",
                (goods_sno, base_name, _username(current_user), datetime.now(_KST).isoformat()),
            )
            # 상품을 바꾸면 이전 상품 기준의 옵션 연결은 의미가 없어진다.
            conn.execute("DELETE FROM cs_option_links WHERE goods_sno = ?", (goods_sno,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.delete("/links/product/{goods_sno}")
    def unlink_product(goods_sno: int, current_user=Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM cs_product_links WHERE goods_sno = ?", (goods_sno,))
            conn.execute("DELETE FROM cs_option_links WHERE goods_sno = ?", (goods_sno,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.put("/links/option")
    def link_option(body: dict = Body(...), current_user=Depends(get_current_user)):
        try:
            goods_sno = int(body["goods_sno"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(status_code=400, detail="goods_sno가 필요합니다.")
        key = str(body.get("option_key") or "").strip()
        code = str(body.get("base_code") or "").strip()
        if not key or not code:
            raise HTTPException(status_code=400, detail="옵션과 원가베이스 상품코드가 필요합니다.")
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO cs_option_links (goods_sno, option_key, base_code, linked_by, linked_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(goods_sno, option_key) DO UPDATE SET base_code = excluded.base_code, "
                "linked_by = excluded.linked_by, linked_at = excluded.linked_at",
                (goods_sno, key, code, _username(current_user), datetime.now(_KST).isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.delete("/links/option")
    def unlink_option(goods_sno: int, option_key: str, current_user=Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM cs_option_links WHERE goods_sno = ? AND option_key = ?", (goods_sno, option_key))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.get("/templates")
    async def templates(current_user=Depends(get_current_user)):
        return await _ably_get(http, "/seller/templates/answer/", {"page": 1, "per_page": 100})

    def _clean_template(payload: dict) -> tuple[str, str]:
        title = str(payload.get("title") or "").strip()
        content = str(payload.get("content") or "").strip()
        if not title or not content:
            raise HTTPException(status_code=400, detail="이름과 내용을 모두 입력하세요.")
        return title, content

    @router.get("/my-templates")
    def list_my_templates(current_user=Depends(get_current_user)):
        conn = get_db()
        try:
            rows = conn.execute("SELECT id, title, content FROM cs_my_templates ORDER BY id").fetchall()
        finally:
            conn.close()
        return {"templates": [{"id": r["id"], "title": r["title"], "content": r["content"]} for r in rows]}

    @router.post("/my-templates")
    def create_my_template(payload: dict = Body(...), current_user=Depends(get_current_user)):
        title, content = _clean_template(payload)
        conn = get_db()
        try:
            cur = conn.execute(
                "INSERT INTO cs_my_templates (title, content, updated_by, updated_at) VALUES (?, ?, ?, ?)",
                (title, content, _username(current_user), datetime.now(_KST).isoformat()),
            )
            conn.commit()
            new_id = cur.lastrowid
        finally:
            conn.close()
        return {"id": new_id, "title": title, "content": content}

    @router.put("/my-templates/{template_id}")
    def update_my_template(template_id: int, payload: dict = Body(...), current_user=Depends(get_current_user)):
        title, content = _clean_template(payload)
        conn = get_db()
        try:
            conn.execute(
                "UPDATE cs_my_templates SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                (title, content, _username(current_user), datetime.now(_KST).isoformat(), template_id),
            )
            conn.commit()
        finally:
            conn.close()
        return {"id": template_id, "title": title, "content": content}

    @router.delete("/my-templates/{template_id}")
    def delete_my_template(template_id: int, current_user=Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM cs_my_templates WHERE id = ?", (template_id,))
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    return router
