"""이지오토(ezauto)의 에이블리 '자동발주' / '판매처 송장등록'을 웹 백엔드에서 직접 수행한다.

이지오토 실제 통신을 캡처해서 확인한 흐름을 그대로 따른다.

자동발주(에이블리)
  1) 에이블리 신규 주문(processing_status=1) 조회
  2) 주문확인: PUT /v1/vendors/order_items/prepare/ {"sno_list": [...]}
  3) 상품준비중 주문(processing_status=2) 전체 조회 (최근 LOOKBACK_DAYS일)
  4) 23열 .xls로 변환해 이지어드민에 업로드:
     POST /function.htm  action=reg_orders_manual, template=DC00, shop_id, mode=1, is_auto=1, _file
     (같은 주문번호는 이지어드민이 중복으로 걸러준다)

판매처 송장등록(에이블리)
  - 상품준비중 주문 중 이지어드민에서 배송(출고)처리된 건(status=8)만, 이지어드민의 송장번호(trans_no)를
    PUT /v1/vendors/order_items/send/ {"data_list": [{"delivery_sno", "invoice", "sno"}]} 로 전송한다.
  - 에이블리 sno == 이지어드민 order_id_seq, 에이블리 order_sno == 이지어드민 order_id
"""
from __future__ import annotations

import asyncio
import random
import re
from datetime import date, datetime, timedelta
from io import BytesIO
from typing import Any, Awaitable, Callable

import httpx
import xlwt

LOOKBACK_DAYS = 16  # 이지오토가 조회하는 기간 (예: 10/27 ~ 11/12)
PER_PAGE = 100
PREPARE_CHUNK = 100
SEND_CHUNK = 100
EZ_SEARCH_DAYS = 60  # 이지어드민에서 주문번호로 검색할 기간
EZ_CONCURRENCY = 5
UPLOAD_TEMPLATE = "DC00"
UPLOAD_VERSION = "1.0.25.599"  # 이지오토 버전 값 (업로드 요청의 version 필드)
EZ_SHIPPED_STATUS = "8"  # 이지어드민 배송(출고)처리 완료
LOTTE_TRANS_CORP_ID = "30079"  # 롯데택배 (에이블리 default_delivery_sno 와 짝)

ORDER_HEADERS = [
    "상품주문번호", "주문번호", "수량", "주문상태", "옵션 정보", "결제일", "주문자명", "연락처", "판매자 상품코드",
    "자체상품코드", "상품명", "택배사", "수취인명", "수취인 연락처", "배송지 주소", "우편번호", "배송 메모",
    "상품 판매가", "배송타입", "오늘 출발 상품 합배송 여부", "배송구분", "솔루션사 고유코드", "개인통관고유부호",
]

Log = Callable[[str], None]


class EzautoError(Exception):
    """사용자에게 그대로 보여줄 수 있는 실행 오류."""


# ---------------------------------------------------------------- 엑셀 변환
def _s(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


# 이지오토가 상품명에서 지우는 이모지. 실제 엑셀(1,280행)과 에이블리 응답을 비교해 확인한 목록이다
# (🖤 ❄ 🔥 💙 ✨ 💗). 다른 이모지(🎀 🤍 💜 🦢 등)는 그대로 남긴다. 뒤따르는 변형 선택자(U+FE0F)도 함께 지운다.
_REMOVED_EMOJI = re.compile("[❄✨\U0001F5A4\U0001F525\U0001F499\U0001F497]️?")


def clean_product_name(text: str) -> str:
    return _REMOVED_EMOJI.sub("", text)


def delivery_type_label(item: dict) -> str:
    """'오늘출발(합배송)' -> '오늘출발', '일반배송' -> '일반배송' (괄호 설명 제거)."""
    return re.sub(r"\(.*?\)", "", _s(item.get("delivery_type_kor"))).strip()


def order_row(item: dict) -> list[str]:
    return [
        _s(item.get("sno")), _s(item.get("order_sno")), _s(item.get("ea")), _s(item.get("status")),
        _s(item.get("option_info")), _s(item.get("checked_at")), _s(item.get("buyer_name")), _s(item.get("buyer_tel")),
        _s(item.get("goods_sno")), _s(item.get("goods_custom_code")), clean_product_name(_s(item.get("goods_name"))), "",
        _s(item.get("receiver_name")), _s(item.get("receiver_tel")), _s(item.get("receiver_addr")),
        _s(item.get("receiver_postcode")), _s(item.get("memo")), _s(item.get("price")),
        delivery_type_label(item), _s(bool(item.get("is_today_combine_delivery"))),
        _s(item.get("delivery_type_kor")), _s(item.get("option_stock_sync_code")), "",
    ]


def _text_xls(headers: list[str], rows: list[list[str]]) -> bytes:
    book = xlwt.Workbook(encoding="utf-8")
    sheet = book.add_sheet("Sheet1")
    # 빈 값도 실제 이지오토 파일처럼 '빈 문자열' 셀로 쓴다 (sheet.write("")는 빈 셀로 저장되어 버림)
    for c, header in enumerate(headers):
        sheet.row(0).set_cell_text(c, header)
    for r, values in enumerate(rows, start=1):
        row = sheet.row(r)
        for c, value in enumerate(values):
            row.set_cell_text(c, value)
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def build_order_xls(items: list[dict]) -> bytes:
    return _text_xls(ORDER_HEADERS, [order_row(item) for item in items])


# ---------------------------------------------------------------- 아무드(10080) 엑셀 변환
AMOOD_ORDER_HEADERS = [
    "결제일", "상품주문번호", "주문번호", "택배사", "택배사 코드", "송장번호", "상품명", "판매자 상품코드", "옵션 정보",
    "수량", "판매금액", "주문자명", "연락처", "수취인명", "우편번호", "배송지 주소", "배송 메모", "주문상태", "에이블리 상품코드",
]
AMOOD_STATUS_LABEL = {"SHIPPING_READYING": "배송 준비중", "PAYMENT_COMPLETED": "결제 완료"}


def amood_order_row(item: dict) -> list[str]:
    """아무드 order_line_item 1건 -> 엑셀 1행 (실제 이지오토 엑셀 78행과 셀 단위로 일치하는 규칙)."""
    order = item.get("order") or {}
    product = item.get("product") or {}
    option = item.get("product_option") or {}
    customer = item.get("customer") or {}
    fwd = (item.get("shipping_item") or {}).get("forwarding_address") or {}
    address = " ".join(_s(fwd.get(k)) for k in ("prefecture", "city", "local", "detail")).strip()
    status = _s(item.get("status"))
    return [
        _s(order.get("placed_at")), _s(item.get("id")), _s(order.get("id")), "", "", "",
        _s(product.get("name_origin")), _s(product.get("custom_code")), "/".join(_s(v) for v in option.get("option_values_origin") or []),
        _s(item.get("quantity")), _s(item.get("sale_price")), _s(customer.get("full_name")), _s(fwd.get("phone_number")),
        _s(fwd.get("full_name")), _s(fwd.get("zipcode")), address, "", AMOOD_STATUS_LABEL.get(status, status),
        _s(product.get("ably_sno")),
    ]


def build_amood_order_xls(items: list[dict]) -> bytes:
    return _text_xls(AMOOD_ORDER_HEADERS, [amood_order_row(item) for item in items])


def upload_filename(shop_id: str, start: date, end: date, *, download: bool = True) -> str:
    return f"{shop_id}_{'download_' if download else ''}{start:%Y%m%d}_{end:%Y%m%d}.xls"


# ---------------------------------------------------------------- 에이블리 공식 API
class AblyVendorClient:
    def __init__(self, token: str, api_key: str, *, base: str = "https://partner.api.a-bly.com", timeout: float = 120.0):
        self._base, self._timeout = base, timeout
        self._headers = {
            "X-Ably-Api-Key": api_key,
            "Authorization": f"Token {token}",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        }

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.request(method, f"{self._base}{path}", headers=self._headers, **kwargs)
        if res.status_code >= 400:
            raise EzautoError(f"에이블리 API 오류 (HTTP {res.status_code}, {method} {path.split('?')[0]}): {res.text[:120]}")
        return res

    async def list_items(self, status: int, start: date, end: date) -> tuple[list[dict], int | None]:
        """processing_status=status 주문 전체(모든 페이지)와 default_delivery_sno를 돌려준다."""
        items: list[dict] = []
        default_delivery_sno = None
        page = 1
        while True:
            res = await self._request("GET", "/v1/vendors/order_items/", params={
                "page": page, "order": "-checked_at", "per_page": PER_PAGE,
                "processing_status[]": status, "processing_sub_status[]": 0, "keyword": "",
                "date_type": "checked_at", "start_date": f"{start:%Y-%m-%d}", "end_date": f"{end:%Y-%m-%d}",
            })
            data = res.json()
            items.extend(data.get("order_items") or [])
            default_delivery_sno = data.get("default_delivery_sno", default_delivery_sno)
            if page >= int(data.get("max_page_number") or 1) or not data.get("order_items"):
                break
            page += 1
        return items, default_delivery_sno

    async def prepare(self, snos: list[int]) -> None:
        for i in range(0, len(snos), PREPARE_CHUNK):
            await self._request("PUT", "/v1/vendors/order_items/prepare/", json={"sno_list": snos[i:i + PREPARE_CHUNK]})

    async def send_invoices(self, data_list: list[dict]) -> dict:
        """{"success_snos": [...], "errors": {...}} 를 합쳐서 돌려준다."""
        success: list[int] = []
        errors: dict[str, list] = {}
        for i in range(0, len(data_list), SEND_CHUNK):
            res = await self._request("PUT", "/v1/vendors/order_items/send/", json={"data_list": data_list[i:i + SEND_CHUNK]})
            body = res.json() if res.content else {}
            success.extend(body.get("success_snos") or [])
            for key, value in (body.get("errors") or {}).items():
                if value:
                    errors.setdefault(key, []).extend(value)
        return {"success_snos": success, "errors": errors}


class AmoodVendorClient:
    """아무드(10080) 공식 API. 에이블리와 같은 서버(/v1/vendors/orders/order-line-items/)에 다른 인증 헤더를 쓴다."""

    def __init__(self, token: str, api_key: str, *, base: str = "https://partner.api.a-bly.com", timeout: float = 120.0):
        self._base, self._timeout = base, timeout
        self._headers = {"authorization": f"TOKEN {token}", "x-amood-api-key": api_key}

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {**self._headers, **kwargs.pop("headers", {})}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.request(method, f"{self._base}{path}", headers=headers, **kwargs)
        if res.status_code >= 400:
            raise EzautoError(f"아무드 API 오류 (HTTP {res.status_code}, {method} {path}): {res.text[:120]}")
        return res

    async def list_items(self, status: str, start: date, end: date) -> list[dict]:
        items: list[dict] = []
        page = 1
        while True:
            res = await self._request("GET", "/v1/vendors/orders/order-line-items/", params={
                "status": status, "order_placed_date_start": f"{start:%Y-%m-%d}", "order_placed_date_end": f"{end:%Y-%m-%d}",
                "page": page, "page_size": PER_PAGE,
            })
            data = res.json()
            items.extend(data.get("order_line_items") or [])
            if page >= int(data.get("total_page") or 1) or not data.get("order_line_items"):
                break
            page += 1
        return items

    async def ship_ready(self, ids: list[int | str]) -> dict:
        """주문확인(배송준비). {"success": [...], "failure": [{"id", "error_code", "message"}]} 를 합쳐서 돌려준다."""
        out: dict[str, list] = {"success": [], "failure": []}
        for i in range(0, len(ids), PREPARE_CHUNK):
            res = await self._request(
                "PUT", "/v1/vendors/orders/order-line-items/bulk-shipping-ready/",
                headers={**self._headers, "Content-Type": "application/json"},
                json={"order_line_items": [{"id": str(x)} for x in ids[i:i + PREPARE_CHUNK]]},
            )
            body = res.json() if res.content else {}
            out["success"].extend(body.get("success") or [])
            out["failure"].extend(body.get("failure") or [])
        return out


async def fetch_shop_token(domain: str, host: str, shop_id: str, *, base: str = "http://ezauto.ezadmin.co.kr") -> str:
    """이지오토가 하는 것과 같이 이지어드민 이지오토 서버에서 판매처 토큰(m_strAuthCode)을 받아온다."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.get(f"{base}/client/function.php", params={
            "cAction": "get_shop_info", "host": host, "domain": domain, "shop_id": shop_id, "RN": random.randint(10**8, 10**9 - 1),
        })
    try:
        token = str(res.json().get("m_strAuthCode") or "").strip()
    except ValueError:
        token = ""
    if not token:
        raise EzautoError("이지오토 서버에서 에이블리 토큰을 받지 못했습니다 (판매처 설정 확인 필요)")
    return token


# ---------------------------------------------------------------- 자동발주
async def run_auto_order(ably: AblyVendorClient, ez, *, shop_id: str, today: date, log: Log) -> dict:
    start = today - timedelta(days=LOOKBACK_DAYS)
    new_items, _ = await ably.list_items(1, start, today)
    new_snos = [int(i["sno"]) for i in new_items if i.get("sno") is not None]
    log(f"에이블리 신규 주문 {len(new_snos)}건 조회")
    if new_snos:
        await ably.prepare(new_snos)
        log(f"주문확인 {len(new_snos)}건 완료")

    items, _ = await ably.list_items(2, start, today)
    log(f"상품준비중 주문 {len(items)}건 조회")
    if not items:
        return {"confirmed": len(new_snos), "items": 0, "uploaded": False, "message": "이지어드민에 입력할 주문이 없습니다."}

    xls = build_order_xls(items)
    log(f"엑셀 {len(items)}행 변환 완료, 이지어드민 업로드 중...")
    resp = await ez.post(
        UPLOAD_TEMPLATE, "reg_orders_manual",
        data={"shop_id": shop_id, "mode": "1", "is_auto": "1", "version": UPLOAD_VERSION},
        files={"_file": (upload_filename(shop_id, start, today), xls, "application/octet-stream")},
        time_flag=None,
    )
    if not isinstance(resp, dict) or not resp.get("success"):
        raise EzautoError(f"이지어드민 발주 입력 실패: {str(resp)[:200]}")
    log(f"이지어드민 발주 입력 완료 (신규 {resp.get('cnt_new')}건)")
    return {
        "confirmed": len(new_snos), "items": len(items), "uploaded": True,
        "ez_total": resp.get("cnt_total"), "ez_new": resp.get("cnt_new"), "ez_balju": resp.get("cnt_balju"),
    }


async def run_auto_order_amood(amood: AmoodVendorClient, ez, *, shop_id: str, today: date, log: Log) -> dict:
    start = today - timedelta(days=LOOKBACK_DAYS)
    new_items = await amood.list_items("PAYMENT_COMPLETED", start, today)
    log(f"신규 주문 {len(new_items)}건 조회")
    confirmed, failed, fail_reasons = 0, 0, {}
    if new_items:
        res = await amood.ship_ready([i["id"] for i in new_items if i.get("id") is not None])
        confirmed, failed = len(res["success"]), len(res["failure"])
        for f in res["failure"]:
            code = str(f.get("error_code") or "UNKNOWN")
            fail_reasons[code] = fail_reasons.get(code, 0) + 1
        log(f"주문확인 성공 {confirmed}건, 실패 {failed}건" + (f" ({', '.join(f'{k} {v}건' for k, v in fail_reasons.items())})" if fail_reasons else ""))

    items = await amood.list_items("SHIPPING_READYING", start, today)
    log(f"배송준비중 주문 {len(items)}건 조회")
    base = {"confirmed": confirmed, "confirm_failed": failed, "fail_reasons": fail_reasons, "items": len(items)}
    if not items:
        return {**base, "uploaded": False, "message": "이지어드민에 입력할 주문이 없습니다."}

    xls = build_amood_order_xls(items)
    log(f"엑셀 {len(items)}행 변환 완료, 이지어드민 업로드 중...")
    resp = await ez.post(
        UPLOAD_TEMPLATE, "reg_orders_manual",
        data={"shop_id": shop_id, "mode": "1", "is_auto": "1", "version": UPLOAD_VERSION},
        files={"_file": (upload_filename(shop_id, start, today, download=False), xls, "application/octet-stream")},
        time_flag=None,
    )
    if not isinstance(resp, dict) or not resp.get("success"):
        raise EzautoError(f"이지어드민 발주 입력 실패: {str(resp)[:200]}")
    log(f"이지어드민 발주 입력 완료 (신규 {resp.get('cnt_new')}건)")
    return {**base, "uploaded": True, "ez_total": resp.get("cnt_total"), "ez_new": resp.get("cnt_new"), "ez_balju": resp.get("cnt_balju")}


# ---------------------------------------------------------------- 판매처 송장등록
def collect_shipped_invoices(order_sno: str, snos: set[str], rows: list[dict], packlists: dict[str, list[dict]]) -> dict[str, dict]:
    """한 주문의 이지어드민 검색결과(rows)와 pack별 상품 목록에서 {sno: {"invoice", "corp"}}을 뽑는다.

    배송(출고)처리된 주문(status=8)의 상품 중 송장번호가 있고, 이지어드민 order_id_seq가 에이블리 sno와 같은 것만.
    """
    found: dict[str, dict] = {}
    for row in rows:
        cell = (row.get("cell") if isinstance(row, dict) else None) or {}
        if str(cell.get("status") or "").strip() != EZ_SHIPPED_STATUS:
            continue
        for item in packlists.get(str(cell.get("pack") or ""), []):
            sno = str(item.get("order_id_seq") or "").strip()
            invoice = str(item.get("trans_no") or "").strip()
            if sno in snos and invoice and str(item.get("status") or "").strip() == EZ_SHIPPED_STATUS:
                found[sno] = {"invoice": invoice, "corp": str(item.get("trans_corp_id") or "").strip()}
    return found


async def run_invoice_register(ably: AblyVendorClient, ez, *, today: date, log: Log) -> dict:
    start = today - timedelta(days=LOOKBACK_DAYS)
    items, default_delivery_sno = await ably.list_items(2, start, today)
    log(f"상품준비중 주문 {len(items)}건 조회")
    if not items:
        return {"checked": 0, "shipped": 0, "sent": 0, "failed": 0, "skipped_corp": 0}
    if not default_delivery_sno:
        raise EzautoError("에이블리 기본 택배사(default_delivery_sno)를 확인하지 못했습니다")

    by_order: dict[str, set[str]] = {}
    for it in items:
        by_order.setdefault(_s(it.get("order_sno")), set()).add(_s(it.get("sno")))
    ez_start = (today - timedelta(days=EZ_SEARCH_DAYS)).strftime("%Y-%m-%d")
    ez_end = today.strftime("%Y-%m-%d")
    sem = asyncio.Semaphore(EZ_CONCURRENCY)
    shipped: dict[str, dict] = {}
    done = 0

    async def check(order_sno: str, snos: set[str]) -> None:
        nonlocal done
        async with sem:
            rows = await ez.query_orders(order_sno, start_date=ez_start, end_date=ez_end, rows=10)
            packs = {str(((r.get("cell") or {}) if isinstance(r, dict) else {}).get("pack") or "")
                     for r in rows if str(((r.get("cell") or {}) if isinstance(r, dict) else {}).get("status") or "").strip() == EZ_SHIPPED_STATUS}
            packs.discard("")
            packlists = {pack: await ez.packlist_items(pack) for pack in packs}
        shipped.update(collect_shipped_invoices(order_sno, snos, rows, packlists))
        done += 1
        if done % 200 == 0:
            log(f"이지어드민 조회 {done}/{len(by_order)}건")

    await asyncio.gather(*(check(o, s) for o, s in by_order.items()))
    log(f"이지어드민 출고처리 {len(shipped)}건 확인")

    targets, skipped_corp = [], 0
    for sno, info in shipped.items():
        if info["corp"] != LOTTE_TRANS_CORP_ID:
            skipped_corp += 1  # 에이블리 기본 택배사(롯데)와 다른 택배사는 잘못 전송하지 않도록 건너뜀
            continue
        targets.append({"delivery_sno": default_delivery_sno, "invoice": info["invoice"], "sno": int(sno)})
    if not targets:
        return {"checked": len(items), "shipped": len(shipped), "sent": 0, "failed": 0, "skipped_corp": skipped_corp}

    log(f"에이블리에 송장 {len(targets)}건 전송 중...")
    result = await ably.send_invoices(targets)
    sent, failed = len(result["success_snos"]), len(targets) - len(result["success_snos"])
    log(f"송장 전송 완료: 성공 {sent}건, 실패 {failed}건")
    return {"checked": len(items), "shipped": len(shipped), "sent": sent, "failed": failed,
            "skipped_corp": skipped_corp, "errors": result["errors"]}


def now_kst_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
