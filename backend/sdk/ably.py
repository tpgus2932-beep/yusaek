from __future__ import annotations
from typing import Any
import re
import httpx
from . import config


def _strip_html(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    return re.sub(r"<[^>]+>", "", text)


def _contact_message_text(row: dict) -> str:
    """CS문의 메시지 한 건에서 표시할 텍스트를 뽑는다.

    구매자/판매자가 직접 입력한 메시지는 content에 그대로 들어있지만,
    자동응답/시스템 카드 메시지는 content가 null이고 card.sections 안의
    HTML 텍스트에 실제 내용이 있다 (실제 브라우저 캡처로 확인됨).
    """
    content = row.get("content")
    if content:
        return str(content)
    card = row.get("card") or {}
    texts = [
        _strip_html(str((section.get("contents") or {}).get("text") or ""))
        for section in (card.get("sections") or [])
        if section.get("type") == "HTML"
    ]
    return "\n".join(t for t in texts if t)


class AblyClient:
    def __init__(self, *, timeout: float = 15.0):
        self._timeout = timeout
        self._token: str | None = None

    async def login(self, *, force: bool = False) -> str:
        if self._token and not force: return self._token
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(f"{config.ABLY_BASE}/seller/login/", json={"email": config.ABLY_EMAIL, "password": config.ABLY_PASSWORD}, headers={"Content-Type": "application/json", "Origin": "https://seller-admin.a-bly.com", "Referer": "https://seller-admin.a-bly.com/", "User-Agent": "Mozilla/5.0"})
        if not response.is_success: raise RuntimeError("Ably login failed")
        token = response.json().get("access_token") or response.json().get("token")
        if not token: raise RuntimeError("Ably login failed: token missing")
        self._token = token
        return token

    @staticmethod
    def headers(token: str, *, origin: str = "seller-admin.a-bly.com") -> dict:
        return {"Authorization": f"JWT {token}", "Accept": "application/json", "Content-Type": "application/json", "Origin": f"https://{origin}", "Referer": f"https://{origin}/", "User-Agent": "Mozilla/5.0"}

    async def request(self, method: str, path: str, *, json: Any = None, params: dict | None = None, origin: str = "seller-admin.a-bly.com", timeout: float | None = None) -> httpx.Response:
        token = await self.login()
        async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
            response = await client.request(method, f"{config.ABLY_BASE}{path}", headers=self.headers(token, origin=origin), json=json, params=params)
        if response.status_code == 401:
            token = await self.login(force=True)
            async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
                response = await client.request(method, f"{config.ABLY_BASE}{path}", headers=self.headers(token, origin=origin), json=json, params=params)
        return response

    # CS문의(contact_rooms) 목록 화면에서 실제로 쓰는 카테고리 전체 목록
    # (진행중/완료 탭 공통, 실제 브라우저 검색 요청 캡처로 확인됨).
    _CONTACT_ROOM_CATEGORIES = [
        2, 101, 120, 3, 102, 121, 4, 103, 122, 5, 104, 123, 9, 11, 106, 125,
        12, 107, 126, 13, 108, 127, 14, 109, 128, 15, 110, 129, 16, 111, 130,
        19, 153, 172,
    ]

    async def count_contact_rooms_by_mobile(self, mobile: str, *, start_date: str, end_date: str) -> int:
        """구매자 전화번호로 CS문의방 개수를 조회 (진행중 status=1,2 + 완료 status=3,4,5 통합).

        셀러어드민 CS문의 화면에서 진행중/완료 탭을 각각 status 다르게 조회하는
        것과 동일한 요청이며, status를 한 번에 합쳐서 호출한다 (실제 브라우저
        검색 요청 캡처로 확인됨).
        """
        response = await self.request(
            "GET", "/seller/contact_rooms/total_count/",
            params={
                "start_date": start_date,
                "end_date": end_date,
                "order": "-updated_latest_message_at",
                "category[]": self._CONTACT_ROOM_CATEGORIES,
                "mobile": mobile,
                "status[]": [1, 2, 3, 4, 5],
            },
        )
        response.raise_for_status()
        data = response.json()
        return int(data.get("total_count") or 0)

    async def list_contact_rooms_by_mobile(self, mobile: str, *, start_date: str, end_date: str) -> list[dict]:
        """구매자 전화번호로 CS문의방 목록(최신순)을 조회. count_contact_rooms_by_mobile와 동일한 파라미터."""
        response = await self.request(
            "GET", "/seller/contact_rooms/",
            params={
                "start_date": start_date,
                "end_date": end_date,
                "order": "-updated_latest_message_at",
                "category[]": self._CONTACT_ROOM_CATEGORIES,
                "mobile": mobile,
                "status[]": [1, 2, 3, 4, 5],
            },
        )
        response.raise_for_status()
        data = response.json()
        return data.get("contact_rooms") or []

    async def get_contact_room_messages(self, sno: int | str) -> dict:
        """CS문의방 하나의 전체 대화 내용을 {status_display, market_name, messages}로 정규화해서 반환."""
        response = await self.request("GET", f"/seller/contact_rooms/{sno}/")
        response.raise_for_status()
        data = response.json()
        room = data.get("contact_room") or {}
        messages = []
        for row in data.get("contact_messages") or []:
            text = _contact_message_text(row)
            if not text:
                continue
            member_type = row.get("member_type") or ""
            sender = "구매자" if member_type == "USER" else "판매자" if member_type == "SELLER" else (member_type or "시스템")
            messages.append({"sender": sender, "content": text, "created_at": row.get("created_at")})
        return {
            "status_display": room.get("get_status_display"),
            "market_name": (room.get("market") or {}).get("name"),
            "messages": messages,
        }

    async def rollback_order_items_to_prepare(self, sno_list: list[int]) -> httpx.Response:
        return await self.request("PUT", "/seller/order_items/rollback_to_prepare/", json={"sno_list": sno_list}, origin="my.a-bly.com")

    async def search_goods(self, *, page: int = 1, per_page: int = 30) -> dict:
        response = await self.request("POST", "/seller/goods/search/", json={"page": page, "per_page": per_page})
        response.raise_for_status()
        return response.json()

    async def get_goods_detail(self, sno: int | str) -> dict:
        response = await self.request("GET", f"/seller/goods/{sno}/")
        response.raise_for_status()
        return response.json().get("goods", {})

    async def get_goods_statistics(self, *, start_date: str, end_date: str, per_page: int = 100) -> list[dict]:
        """상품별 판매 통계 전체 페이지 조회 (인기재고 랭킹 등 상품 단위 집계에 사용)."""
        all_goods: list[dict] = []
        page = 1
        while True:
            response = await self.request(
                "GET", "/seller/statistics/goods/",
                params={
                    "page": page,
                    "per_page": per_page,
                    "option_enable": "true",
                    "start_date": start_date,
                    "end_date": end_date,
                },
                origin="my.a-bly.com",
            )
            response.raise_for_status()
            data = response.json()
            goods = ((data.get("results") or {}).get("statistics")) or []
            if not goods:
                break
            all_goods.extend(goods)
            if page >= data.get("max_page_number", 1):
                break
            page += 1
        return all_goods

    async def list_exchanges(self, *, status: int | list[int], start_date: str, end_date: str, per_page: int = 30) -> list[dict]:
        """상태별 교환 목록 전체 페이지 조회.

        status 예: 2=교환요청, 3=교환수거중, 4=수거완료, 9=교환출고대기.
        """
        statuses = status if isinstance(status, list) else [status]
        all_exchanges: list[dict] = []
        page = 1
        while True:
            response = await self.request("GET", "/seller/exchanges/", params={
                "page": page,
                "per_page": per_page,
                "requested_at_start": f"{start_date} 00:00:00",
                "requested_at_end": f"{end_date} 23:59:59",
                "status[]": statuses,
            })
            response.raise_for_status()
            data = response.json()
            exchanges = data.get("exchanges", [])
            if not exchanges:
                break
            all_exchanges.extend(exchanges)
            if page >= data.get("max_page_number", 1):
                break
            page += 1
        return all_exchanges

    async def list_order_cancels(self, *, cancel_type: str = "return", processing_sub_status: list[str] | None = None, delivery_type: list[str] | None = None, start_date: str, end_date: str, per_page: int = 30) -> list[dict]:
        """취소/반품 목록 전체 페이지 조회."""
        params_base = {
            "cancel_type": cancel_type,
            "processing_sub_status[]": processing_sub_status or ["41", "42"],
            "delivery_type[]": delivery_type or ["standard", "today", "combine", "reserved"],
            "order": "cancel_received_at",
            "per_page": per_page,
            "start_date": start_date,
            "end_date": end_date,
        }
        all_cancels: list[dict] = []
        page = 1
        while True:
            response = await self.request("GET", "/seller/order_cancels/", params={**params_base, "page": page})
            response.raise_for_status()
            data = response.json()
            cancels = data.get("order_cancels", [])
            if not cancels:
                break
            all_cancels.extend(cancels)
            if page >= data.get("max_page_number", 1):
                break
            page += 1
        return all_cancels

    async def reject_order_cancel(self, sno: int | str, *, refuse_cause_comment: str) -> httpx.Response:
        """취소/반품 요청 거부 처리."""
        return await self.request("PUT", f"/seller/order_cancels/{sno}/reject_request/", json={"refuse_cause_comment": refuse_cause_comment}, origin="my.a-bly.com")

    async def confirm_order_items(self, sno_list: list[int]) -> None:
        """구매자 취소요청 승인(확정) 처리 (실제 브라우저 캡처로 확인).

        order_cancels 목록의 order_items[].sno(주문상품 sno, cancel_sno나
        order_sno와는 다름)를 넘겨야 한다.
        """
        response = await self.request(
            "PUT", "/seller/order_items/request_confirm/",
            json={"sno_list": sno_list},
            origin="my.a-bly.com",
        )
        response.raise_for_status()

    async def search_order_items_by_goods_name(self, keyword: str, *, per_page: int = 100) -> list[dict]:
        """상품명으로 미발송(processing_status=2) 주문상품 전체 페이지 조회.

        keyword_type을 goods_name으로 고정하면 에이블리가 내부 goods_name
        필드에 대해 부분일치 검색을 해준다 (앞의 태그/이모지 접두사가
        붙어 있어도 매칭됨 - 실제 브라우저 캡처로 확인).
        """
        all_items: list[dict] = []
        page = 1
        while True:
            response = await self.request(
                "GET", "/seller/order_items/",
                params={
                    "order": "-checked_at",
                    "delivery_type[]": ["standard", "today", "combine", "reserved"],
                    "processing_status[]": 2,
                    "processing_sub_status[]": 0,
                    "page": page,
                    "per_page": per_page,
                    "keyword": keyword,
                    "keyword_type": "goods_name",
                },
                origin="my.a-bly.com",
            )
            response.raise_for_status()
            data = response.json()
            items = data.get("order_items") or []
            if not items:
                break
            all_items.extend(items)
            if page >= data.get("max_page_number", 1):
                break
            page += 1
        return all_items

    async def get_order_refund_info(self, order_sno: int | str) -> dict:
        """주문 상세에서 환불계좌 정보와 구매자 연락처/이름을 가져온다.

        receive_cancel 호출에 필요한 refund_bank_account_holder/number/sno와
        품절문자 발송용 buyer_tel, 결과 화면 표시용 buyer_name을 한 번에
        담고 있다 (실제 캡처로 확인).
        """
        response = await self.request(
            "GET", f"/seller/orders/{order_sno}/items/",
            params={"processing_status[]": [1, 2], "processing_sub_status[]": 0},
            origin="my.a-bly.com",
        )
        response.raise_for_status()
        order = response.json().get("order") or {}
        refund_bank = order.get("refund_bank") or {}
        return {
            "refund_bank_sno": refund_bank.get("sno"),
            "refund_bank_account_holder": order.get("refund_bank_account_holder"),
            "refund_bank_account_number": order.get("refund_bank_account_number"),
            "buyer_tel": order.get("buyer_tel"),
            "buyer_name": order.get("buyer_name"),
        }

    async def cancel_order_items(
        self,
        order_sno: int | str,
        sno_list: list[int],
        *,
        refund_bank_account_holder: str,
        refund_bank_account_number: str,
        refund_bank_sno: int,
        cancel_reason: int = 2,
    ) -> dict:
        """주문상품 취소. cancel_reason=2는 품절 사유 (실제 캡처로 확인).

        성공 시 이후 미진열/품절 처리해야 할 옵션·상품 목록을
        {need_to_be_non_display_option_list, need_to_be_soldout_goods_list}로
        돌려준다 - stop_selling() 호출에 그대로 사용.
        """
        response = await self.request(
            "POST", "/seller/order_items/receive_cancel/",
            json={
                "order_sno": order_sno,
                "cancel_reason": cancel_reason,
                "cancel_type": "cancel",
                "sno_list": sno_list,
                "refund_bank_account_holder": refund_bank_account_holder,
                "refund_bank_account_number": refund_bank_account_number,
                "refund_bank_sno": refund_bank_sno,
            },
            origin="my.a-bly.com",
        )
        response.raise_for_status()
        return response.json()

    async def stop_selling(self, *, non_display_option_snos: list[int], soldout_goods_snos: list[int]) -> None:
        """옵션 단위 미진열/상품 단위 품절을 일괄 반영. 응답 바디는 비어있다(실제 캡처로 확인)."""
        response = await self.request(
            "POST", "/seller/goods/stop-selling/",
            json={
                "need_to_be_non_display_option_sno_list": non_display_option_snos,
                "need_to_be_soldout_goods_sno_list": soldout_goods_snos,
            },
            origin="my.a-bly.com",
        )
        response.raise_for_status()

    def set_token(self, token: str) -> None:
        """이미 확보한 JWT를 재사용해 재로그인을 피할 때 사용."""
        self._token = token
