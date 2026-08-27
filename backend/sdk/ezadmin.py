from __future__ import annotations

from datetime import datetime
from typing import Any
import io
import json
import re
import httpx
import xlwt
from . import config

_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def first_present(obj: Any, keys: tuple[str, ...]) -> Any:
    """첫 번째로 값이 있는 키를 재귀적으로 찾는다 (중첩 dict/list 대응)."""
    if isinstance(obj, dict):
        for key in keys:
            if obj.get(key) not in (None, ""):
                return obj[key]
        for value in obj.values():
            found = first_present(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = first_present(value, keys)
            if found not in (None, ""):
                return found
    return None


def extract_sms_rows(payload: Any) -> list[dict]:
    """EZDesk A100 응답(대화 히스토리)에서 메시지 행 리스트를 뽑아낸다."""
    if isinstance(payload, dict):
        if isinstance(payload.get("chats"), dict):
            return [item for day in payload["chats"].values() if isinstance(day, list) for item in day if isinstance(item, dict)]
        if isinstance(payload.get("list"), list):
            return [x for x in payload["list"] if isinstance(x, dict)]
        for key in ("messages", "smsList", "list", "rows", "data", "result"):
            if isinstance(payload.get(key), list):
                return [x for x in payload[key] if isinstance(x, dict)]
        for value in payload.values():
            found = extract_sms_rows(value)
            if found:
                return found
    elif isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    return []


def _clean_sms_content(text: str) -> str:
    # EZDesk stores line breaks as literal "<br>" tags in the message body,
    # which renders as literal text (not a line break) once shown as plain
    # text on the frontend - swap them for real newlines.
    return re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)


_SMS_ATTACHMENT_KEYS = ("img1", "img2", "img3", "img4", "img5", "vid1", "vid2", "vid3", "vid4", "vid5")


def _sms_attachment_urls(row: dict) -> list[str]:
    # EZDesk MMS(사진/동영상) 메시지는 "message" 필드가 빈 문자열이고 실제 첨부는
    # img1~img5/vid1~vid5에 URL로 내려온다 - 그대로 두면 사진을 받고도
    # received_content가 빈 줄로 보여 아무것도 안 온 것처럼 보인다.
    return [str(row.get(k)).strip() for k in _SMS_ATTACHMENT_KEYS if str(row.get(k) or "").strip()]


def normalize_sms_row(row: dict) -> dict:
    """EZDesk 대화 행 하나를 {input_time, direction, sender, receiver, content, cs_type}로 정규화."""
    msg_type = str(row.get("msg_type") or "").lower()
    if msg_type == "me":
        direction = "sent"
    elif msg_type == "you":
        direction = "received"
    else:
        raw_direction = str(first_present(row, ("direction", "type", "inout", "io", "send_type")) or "").lower()
        direction = "received" if any(x in raw_direction for x in ("in", "receive", "수신", "받")) else "sent" if any(x in raw_direction for x in ("out", "send", "발송", "보냄")) else "unknown"
    text = _clean_sms_content(str(row.get("message") or row.get("content") or first_present(row, ("msg", "sms", "body")) or ""))
    attachments = _sms_attachment_urls(row)
    if attachments:
        attachment_note = "\n".join("[사진]" for _ in attachments)
        text = f"{text}\n{attachment_note}" if text else attachment_note
    return {
        "input_time": row.get("crdate") or row.get("input_time") or first_present(row, ("inputTime", "reg_date", "send_date", "date", "created_at")),
        "direction": direction,
        "sender": str(row.get("sender") or first_present(row, ("send_mobile", "sendMobile", "from")) or ""),
        "receiver": str(row.get("recv_mobile") or first_present(row, ("receiver", "phone", "mobile", "to")) or ""),
        "content": text,
        "cs_type": str(row.get("cs_type") or ""),
    }


def _build_i200_stock_xls(items: list[dict]) -> bytes:
    """I200(재고조정) 일괄 입고/출고 업로드용 엑셀 생성 (헤더: 상품코드/작업수량/메모).

    실캡처(브라우저에서 상품 일괄 입고/출고 실행) 기준 업로드 파일 포맷 -
    다른 화면들(barcode_routes/returns_routes 등)의 I200 업로드 엑셀과 동일한 헤더."""
    book = xlwt.Workbook()
    sheet = book.add_sheet("stock")
    for col, header in enumerate(("상품코드", "작업수량", "메모")):
        sheet.write(0, col, header)
    for row_idx, item in enumerate(items, start=1):
        sheet.write(row_idx, 0, str(item.get("product_id") or "").strip())
        sheet.write(row_idx, 1, int(item.get("qty") or 0))
        sheet.write(row_idx, 2, str(item.get("memo") or ""))
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


class EzAdminSessionExpired(Exception):
    pass


class EzDeskSessionExpired(EzAdminSessionExpired):
    """EZDesk (ezdesk.ezadmin.co.kr) session is missing/invalid.

    Distinct from the main EZAdmin (ga80.ezadmin.co.kr) session - the two
    domains use separate logins despite both cookies being named PHPSESSID,
    so callers need to know which one to prompt the user to re-paste.
    """


class EzAdminClient:
    def __init__(self, get_setting, *, timeout: float = 30.0):
        self._get_setting = get_setting
        self._timeout = timeout

    def _phpsessid(self) -> str:
        sid = str(self._get_setting(config.EZADMIN_SESSION_KEY) or "").strip()
        if not sid:
            raise EzAdminSessionExpired("no PHPSESSID stored in settings")
        return sid

    def _ezdesk_phpsessid(self) -> str:
        # ezdesk.ezadmin.co.kr is a separate subdomain/login from
        # ga80.ezadmin.co.kr (config.EZADMIN_BASE) - its PHPSESSID cookie is
        # not interchangeable with the main EZAdmin session even though both
        # are named PHPSESSID. Using the wrong one doesn't 404 or redirect to
        # a login page; EZDesk just returns a generic
        # "mysqli 데이터베이스에 연결할 수 없습니다" HTML error, which
        # looks_like_session_error doesn't recognize as a session problem.
        sid = str(self._get_setting(config.EZDESK_SESSION_KEY) or "").strip()
        if not sid:
            raise EzDeskSessionExpired("no EZDesk PHPSESSID stored in settings")
        return sid

    @staticmethod
    def time_flag(mode: str = "browser", now: datetime | None = None) -> str:
        now = now or datetime.now()
        if mode == "epoch_ms":
            return str(int(now.timestamp() * 1000))
        return f"{_WEEKDAYS[now.weekday()]} {_MONTHS[now.month - 1]} {now.day:02d} {now.year} {now:%H:%M:%S} GMT+0900 (대한민국 표준시)"

    @staticmethod
    def looks_like_session_error(response: httpx.Response, body: str) -> bool:
        lowered = (body or "").lower()
        return bool((response.url and "login" in str(response.url).lower()) or "<html" in lowered or "<!doctype html" in lowered or any(t in lowered for t in ("login", "phpsessid", "session", "로그인")))

    @staticmethod
    def _looks_like_login_page(response: httpx.Response, body: str) -> bool:
        """upload_new 전용 - looks_like_session_error보다 좁은 판별.

        I200 upload_new는 정상 성공 시에도 JSON이 아닌 응답을 돌려준다(실캡처로
        확인 안 됨 - 다른 I200 화면들의 raw httpx 구현이 전부 이 좁은 체크만
        쓰는 것으로 미루어 짐작). looks_like_session_error를 그대로 쓰면 정상
        응답의 흔한 단어(session/login 등 포함 가능성)를 세션 만료로 오판해
        PHPSESSID가 멀쩡한데도 계속 재입력을 요구하게 된다."""
        lowered = (body or "").lower()
        if response.url and "login" in str(response.url).lower():
            return True
        return "login.htm" in lowered or "login_form" in lowered

    async def post(self, template: str, action: str, *, data: dict[str, Any] | None = None, par: str | None = None, files=None, time_flag: str | None = "browser", extra_headers: dict[str, str] | None = None, require_json: bool = True) -> dict:
        """``require_json=False``: 성공해도 JSON을 안 돌려주는 액션용(예: I200 upload_new).

        기본 동작(``require_json=True``)은 "JSON이 아니면 세션 만료"로 간주하는데,
        이 가정이 깨지는 액션마다 그동안 register_return_pickup/_ezdesk_post처럼
        raw httpx를 새로 복붙해왔다 - 매번 같은 실수(정상 응답을 세션 만료로
        오판)가 반복되는 근본 원인. ``require_json=False``면 좁은 로그인 페이지
        판별(``_looks_like_login_page``)만 쓰고 상태코드/본문을 그대로 반환한다."""
        form: dict[str, Any] = {"template": template, "action": action, **(data or {})}
        if par is not None: form["par"] = par
        if time_flag: form.setdefault("timeFlag", self.time_flag(time_flag))
        headers = {"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest", "Referer": f"{config.EZADMIN_BASE}/popup25.htm?template={template}", **(extra_headers or {})}
        async with httpx.AsyncClient(timeout=self._timeout, verify=False, follow_redirects=True) as client:
            response = await client.post(f"{config.EZADMIN_BASE}/function.htm", data=form, files=files, cookies={"PHPSESSID": self._phpsessid()}, headers=headers)
        body = (response.text or "").strip()
        if not require_json:
            if self._looks_like_login_page(response, body):
                raise EzAdminSessionExpired(f"{template}/{action}: session expired or invalid")
            if not (200 <= response.status_code < 300):
                raise RuntimeError(f"{template}/{action}: HTTP {response.status_code}")
            return {"status": response.status_code, "text": body}
        if self.looks_like_session_error(response, body): raise EzAdminSessionExpired(f"{template}/{action}: session expired or invalid")
        try: return response.json()
        except Exception as exc: raise EzAdminSessionExpired(f"{template}/{action}: non-JSON response") from exc

    async def query_orders(self, super_keyword: str, *, start_date: str, end_date: str, rows: int = 10) -> list[dict]:
        par = f"pack=&history_seq=&date_type=collect_date&start_date={start_date}&end_date={end_date}&date_period_sel=0&search_type=0&keyword=&keyword1=&keyword2=&keyword3=&keyword4=&keyword5=&super_keyword={super_keyword}&order_status=-1&order_cs=0&query_trans_who=0&is_gift=0&work_type=0&labels_string=&checkbox_options_string="
        data = await self.post("E900", "query_json", data={"_search": "false", "rows": str(rows), "page": "1", "sidx": "", "sord": "desc", "readonly": "T"}, par=par, time_flag="epoch_ms")
        return data.get("rows") or []

    async def find_pack_by_order_sno(self, order_sno: str | int, *, start_date: str, end_date: str) -> str | None:
        """에이블리 order_sno로 EZAdmin 주문을 검색해 pack(≈seq)을 반환.

        EZAdmin 검색창에 order_sno를 그대로 입력했을 때와 동일한 방식
        (``search_type=0`` + ``super_keyword=<order_sno>``, 접두사 없음) -
        즉 ``query_orders``와 완전히 동일한 검색이라 그대로 재사용한다.
        (실제 브라우저 검색 요청 캡처로 검증됨 - super_keyword에 접두사를
        붙이는 다른 화면의 패턴을 여기 그대로 가져다 쓰면 안 됨.)
        """
        rows = await self.query_orders(str(order_sno), start_date=start_date, end_date=end_date, rows=10)
        for row in rows:
            cell = row.get("cell") if isinstance(row, dict) else None
            pack = first_present(cell or row, ("pack", "pack_seq", "seq", "order_seq"))
            if pack:
                return str(pack)
        return None

    async def find_order_by_invoice(self, invoice_no: str, *, start_date: str, end_date: str) -> dict | None:
        """송장번호(super_keyword)로 EZAdmin 주문을 검색해 pack과 수취인 전화번호를 함께 반환.

        query_orders 검색 결과 한 번으로 수취인 전화번호(cell.recv_tel)와,
        packlist_json 호출(상품코드 조회)에 필요한 pack을 동시에 얻는다
        (실제 브라우저 검색 요청 캡처로 확인됨).
        """
        rows = await self.query_orders(str(invoice_no), start_date=start_date, end_date=end_date, rows=10)
        for row in rows:
            cell = row.get("cell") if isinstance(row, dict) else None
            pack = first_present(cell or row, ("pack",))
            if not pack:
                continue
            phone = first_present(cell or row, ("recv_tel", "recv_mobile"))
            return {"pack": str(pack), "phone": str(phone) if phone else None}
        return None

    async def packlist(self, pack: str) -> dict:
        return await self.post("E900", "packlist_json", data={"_search": "false", "rows": "500", "page": "1", "sidx": "", "sord": "", "readonly": "T", "pack": pack, "stock": "0", "is_masking": "0"}, time_flag="epoch_ms")

    async def packlist_items(self, pack: str | int) -> list[dict]:
        """packlist_json 결과를 라인아이템 단위로 펼쳐서 반환.

        각 row의 ``cell.data_row``는 라인아이템 전용 필드(``prd_seq``,
        ``trans_corp_id``, ``product_id`` 등)를 담은 JSON 문자열로 이중
        인코딩되어 있다 - ``change_product``에 넘길 ``prd_seq``의 실제
        출처가 바로 이 필드다 (packlist 상위 레벨에는 없음).
        """
        data = await self.packlist(str(pack))
        items: list[dict] = []
        for row in data.get("rows") or []:
            raw = (row.get("cell") or {}).get("data_row")
            if not raw:
                continue
            try:
                items.append(json.loads(raw))
            except (TypeError, ValueError):
                continue
        return items

    async def get_cs_history(self, seq: str | int, *, cs_all: bool = True) -> dict:
        """Return the E900 CS history for a changing order/transaction sequence."""
        seq_value = str(seq).strip()
        if not seq_value:
            raise ValueError("seq is required")
        return await self.post(
            "E900",
            "get_cs_history",
            data={
                "readonly": "T",
                "seq": seq_value,
                "cs_all": "true" if cs_all else "false",
            },
            time_flag="epoch_ms",
        )

    async def change_product(
        self,
        seq: str | int,
        prd_seq: str | int,
        *,
        product_id: str,
        old_product_id: str,
        options: str = "",
        qty: int = 1,
        trans_corp: str | int = 0,
        trans_who: str | int = 1,
        extra_money: int = 0,
        reason: str = "",
        match_type: int = 1,
        pack_same_order: int = 1,
        send_msg: int = 0,
        confirm_refund: int = 0,
        change_to_gift: int = 0,
    ) -> dict:
        """E900 상품 교환/변경 처리. 반품 없이 주문상품(prd_seq)을 old_product_id에서 product_id로 즉시 교체.

        ``prd_seq``는 ``packlist_items(seq)``가 반환하는 라인아이템의
        ``prd_seq`` 필드에서 가져온다 (packlist_json 상위 레벨이 아니라
        ``cell.data_row`` 안에 있음 - ``packlist_items`` 참고).

        성공 시 ``{"error": 0}`` 형태로 응답 - 호출부에서 ``error`` 값을 확인해야 함.
        """
        data = {
            "seq": str(seq),
            "prdSeq": str(prd_seq),
            "product_id": product_id,
            "old_product_id": old_product_id,
            "options": options,
            "qty": str(qty),
            "extra_money": str(extra_money),
            "reason": reason,
            "match_type": str(match_type),
            "restockin": "0",
            "restockin_ex": "0",
            "restockin_cross": "0",
            "restockin_bad": "0",
            "return_comp": "0",
            "site_p": "0",
            "envelop_p": "0",
            "account_p": "0",
            "notget_p": "0",
            "notget_p2": "0",
            "trans_corp": str(trans_corp),
            "trans_no": "",
            "memo": "",
            "trans_who": str(trans_who),
            "trans_price": "",
            "miss_match": "0",
            "status_1_change_product": "0",
            "pack_same_order": str(pack_same_order),
            "content": "",
            "callid": "",
            "confirm_refund": str(confirm_refund),
            "auto_insert_takeback_order": "0",
            "send_msg": str(send_msg),
            "change_to_gift": str(change_to_gift),
        }
        return await self.post("E900", "change_product", data=data, time_flag="epoch_ms")

    async def copy_order(
        self,
        seq: str | int,
        prd_seq: str | int,
        *,
        shop_id: str | int,
        product_id: str,
        product_name: str,
        options: str = "",
        qty: int = 1,
        extra_money: int = 0,
        content: str = "",
    ) -> dict:
        """E900 주문복사. CS 팝업(popup25.htm?template=E900)에서 라인아이템 하나를 그대로 복제해 새 주문을 만든다.

        ``product_name``은 ``packlist_items(seq)`` 라인아이템의 내부 ``product_name``이
        아니라 ``shop_product_name``(대괄호 태그 포함, 쇼핑몰 노출용 상품명)이어야 한다 -
        실제 브라우저 캡처(HAR)에서 이 파라미터 값이 shop_product_name과 일치함을 확인함.
        ``extra_money``도 ``shop_price``(콤마 포함 문자열)가 아니라 ``amount``(정수) 값이다.

        성공 시 ``{"error": 0}`` 형태로 응답 - 호출부에서 ``error`` 값을 확인해야 함.
        """
        data = {
            "seq": str(seq),
            "shop_id": str(shop_id),
            "product_id": product_id,
            "options": options,
            "qty": str(qty),
            "extra_money": str(extra_money),
            "content": content,
            "product_name": product_name,
            "prd_seq": str(prd_seq),
        }
        return await self.post("E900", "copy_order", data=data, time_flag="epoch_ms")

    async def cancel_trans(self, seq: str) -> dict:
        return await self.post("E900", "cancel_trans", data={"seq": seq, "content": ""}, time_flag="epoch_ms")

    async def delete_trans_no(self, seq: str) -> dict:
        return await self.post("E900", "delete_trans_no", data={"seq": seq, "content": ""}, time_flag="epoch_ms")

    async def set_stock_data(self, product_id: str, qty: int, *, type_: str = "out", bad: str = "0") -> dict:
        return await self.post("I100", "set_stock_data", data={"product_id": product_id, "bad": bad, "type": type_, "stock_label": "", "move_warehouse": "0", "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": ""}, time_flag="browser")

    async def receive_stock(self, product_id: str, qty: int = 1, *, memo: str = "") -> dict:
        """I100(재고관리) 입고처리. set_stock_data의 type="in" 방향 - "out"(출고)만
        실캡처로 검증됐고 "in"은 UI의 입고/출고 토글 반대쪽 값으로 추정한 것이라
        처음 쓸 때는 결과를 확인해보는 게 좋다."""
        return await self.post("I100", "set_stock_data", data={"product_id": product_id, "bad": "0", "type": "in", "stock_label": "", "move_warehouse": "0", "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": memo}, time_flag="browser")

    # I200(재고조정) 일괄 입고/출고 - receive_stock/set_stock_data(I100, 상품 1건씩)와
    # 달리 엑셀 한 장으로 여러 상품코드를 한 번에 처리한다. 실캡처(입고/출고 각각)로
    # 확인된 3단계 흐름: upload_new(엑셀 업로드로 서버에 스테이징) ->
    # load_template_data_new(스테이징된 목록 미리보기) -> apply_new(type="in"/"out"으로 확정).
    # 이 템플릿의 요청들은 Referer가 popup25.htm이 아니라 template40.htm?template=I210으로
    # 와야 정상 응답한다(실캡처로 확인됨) - 다른 I200 화면들도 전부 이 Referer를 쓴다.
    _I200_REFERER = {"Referer": f"{config.EZADMIN_BASE}/template40.htm?template=I210"}

    async def bulk_stock_upload(self, items: list[dict]) -> dict:
        """I200 일괄 입고/출고 1단계: {"product_id", "qty", "memo"} 목록을 엑셀로 업로드해 서버에 스테이징.

        업로드만으로는 재고에 반영되지 않는다 - bulk_stock_apply까지 호출해야 확정된다.
        보통은 bulk_receive_stock/bulk_ship_stock으로 3단계를 한 번에 실행하는 편이 낫다.
        """
        if not items:
            raise ValueError("items is required")
        xls_bytes = _build_i200_stock_xls(items)
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        return await self.post(
            "I200", "upload_new",
            files={"_file": (f"stock_{ts_ms}.xls", xls_bytes, "application/vnd.ms-excel")},
            time_flag=None,
            extra_headers=self._I200_REFERER,
            require_json=False,
        )

    async def bulk_stock_preview(self, *, rows: int = 99999) -> dict:
        """I200 일괄 입고/출고 2단계: 현재 스테이징된 상품 목록 미리보기 (apply_new 확정 전 확인용)."""
        ts_ms = str(int(datetime.now().timestamp() * 1000))
        return await self.post(
            "I200", "load_template_data_new",
            data={"_search": "false", "nd": ts_ms, "rows": str(rows), "page": "1", "sidx": "", "sord": "asc"},
            time_flag=None,
            extra_headers=self._I200_REFERER,
        )

    async def bulk_stock_apply(self, type_: str, *, bad: str = "0", move_warehouse: str = "0", save_stock: str = "0", stock_tag: str = "") -> dict:
        """I200 일괄 입고/출고 3단계: 스테이징된 상품 목록을 type_="in"(입고)/"out"(출고)으로 확정.

        성공 시 ``{"msg": "완료", "error": 0}`` 형태로 응답 - 호출부에서 ``error`` 값을 확인해야 함.
        """
        return await self.post(
            "I200", "apply_new",
            data={"bad": bad, "type": type_, "move_warehouse": move_warehouse, "save_stock": save_stock, "stock_tag": stock_tag},
            extra_headers=self._I200_REFERER,
        )

    async def bulk_receive_stock(self, items: list[dict]) -> dict:
        """상품코드/수량 목록으로 EZAdmin I200 일괄 입고처리 (업로드->미리보기->확정 3단계 자동 실행).

        ``items``: ``[{"product_id": "S12345", "qty": 3, "memo": "..."}, ...]``
        """
        await self.bulk_stock_upload(items)
        await self.bulk_stock_preview()
        return await self.bulk_stock_apply("in")

    async def bulk_ship_stock(self, items: list[dict]) -> dict:
        """상품코드/수량 목록으로 EZAdmin I200 일괄 출고처리 (업로드->미리보기->확정 3단계 자동 실행).

        ``items``: ``[{"product_id": "S12345", "qty": 3, "memo": "..."}, ...]``
        """
        await self.bulk_stock_upload(items)
        await self.bulk_stock_preview()
        return await self.bulk_stock_apply("out")

    async def get_pending_order_count(self, product_id: str) -> int:
        """I100(현재고조회)에서 상품코드로 검색해 '접수'(출고 전 대기 주문) 수량을 가져온다.

        응답의 rows[0].cell.before_trans는 ``<a ...>56</a>`` 형태의 HTML
        문자열로 내려온다 - 실제 브라우저 요청 재현(curl)으로 확인됨. 이
        엔드포인트는 timeFlag를 보내지 않는다 (다른 I100 액션들과 달리
        캡처된 요청에 없었음).
        """
        today = datetime.now().strftime("%Y-%m-%d")
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1"
            f"&query_type=product_id&query_str={product_id}"
            "&stock_type=0&stock_start=&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00:00:00&end_date={today}&end_hour=23:59:59"
            "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
            "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )
        data = await self.post(
            "I100", "search",
            data={"_search": "false", "rows": "100", "page": "1", "sidx": "", "sord": "asc", "page_code": "I100"},
            par=par, time_flag=None,
        )
        rows = data.get("rows") or []
        if not rows:
            raise ValueError(f"상품코드 {product_id}를 찾을 수 없습니다")
        cell = (rows[0] or {}).get("cell") or {}
        before_trans_html = str(cell.get("before_trans") or "")
        match = re.search(r">(\d+)</a>", before_trans_html)
        return int(match.group(1)) if match else 0

    async def get_stock_and_pending(self, product_id: str) -> dict:
        """I100(현재고조회)에서 상품코드로 검색해 재고(stock_normal)와 접수(before_trans,
        출고 전 대기 주문) 수량을 함께 가져온다. get_pending_order_count와 동일한 조회를
        한 번만 호출해 두 값을 같이 얻고 싶을 때 사용."""
        today = datetime.now().strftime("%Y-%m-%d")
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1"
            f"&query_type=product_id&query_str={product_id}"
            "&stock_type=0&stock_start=&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00:00:00&end_date={today}&end_hour=23:59:59"
            "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
            "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )
        data = await self.post(
            "I100", "search",
            data={"_search": "false", "rows": "100", "page": "1", "sidx": "", "sord": "asc", "page_code": "I100"},
            par=par, time_flag=None,
        )
        rows = data.get("rows") or []
        if not rows:
            raise ValueError(f"상품코드 {product_id}를 찾을 수 없습니다")
        cell = (rows[0] or {}).get("cell") or {}
        try:
            stock = int(float(cell.get("stock_normal") or 0))
        except (TypeError, ValueError):
            stock = 0
        before_trans_html = str(cell.get("before_trans") or "")
        match = re.search(r">(\d+)</a>", before_trans_html)
        pending = int(match.group(1)) if match else 0
        return {"stock": stock, "pending": pending}

    async def get_stock_for_codes(self, product_ids: list[str]) -> dict[str, int]:
        """I100(현재고조회)에서 여러 상품코드를 한 번에 검색해 코드별 재고(stock_normal)를 가져온다.

        query_str에 상품코드를 ", "로 이어붙이면 이지어드민이 동시 검색을 지원한다
        (실제 브라우저 요청 캡처로 확인). 응답 rows의 cell.key가 상품코드다
        (wonbe_routes.py의 동일 I100/search 호출로 이미 확인된 필드).
        """
        codes = [str(c).strip() for c in product_ids if str(c).strip()]
        if not codes:
            return {}
        today = datetime.now().strftime("%Y-%m-%d")
        query_str = ", ".join(codes)
        par = (
            "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
            "&tags_string=&product_tag_include_type=1"
            f"&query_type=product_id&query_str={query_str}"
            "&stock_type=0&stock_start=&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
            f"&start_date={today}&start_hour=00:00:00&end_date={today}&end_hour=23:59:59"
            "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
            f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
            "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
        )
        rows_count = max(200, len(codes) * 2)
        data = await self.post(
            "I100", "search",
            data={"_search": "false", "rows": str(rows_count), "page": "1", "sidx": "", "sord": "asc", "page_code": "I100"},
            par=par, time_flag=None,
        )
        result: dict[str, int] = {}
        for row in data.get("rows") or []:
            cell = (row or {}).get("cell") or {}
            code = str(cell.get("key") or "").strip()
            if not code:
                continue
            try:
                result[code] = int(float(cell.get("stock_normal") or 0))
            except (TypeError, ValueError):
                result[code] = 0
        return result

    async def sms_chat_detail(
        self,
        phone: str,
        send_mobile: str,
        *,
        current_tab: int | str = 0,
        is_kakao: int | str = 0,
        view_all: int | str = 1,
    ) -> dict:
        """Read the EZDesk A100 conversation for a recipient/sender pair."""
        return await self._ezdesk_post(
            "view_chat_t2",
            {
                "phone": phone,
                "send_mobile": send_mobile,
                "current_tab": str(current_tab),
                "is_kakao": str(is_kakao),
                "view_all": str(view_all),
            },
        )

    async def send_sms(self, receiver: str, sender: str, msg: str) -> dict:
        """Send one SMS through EZDesk's A100 ``send_sms`` action."""
        return await self._ezdesk_post(
            "send_sms",
            {"receiver": receiver, "sender": sender, "msg": msg},
            multipart=True,
        )

    async def register_return_pickup(self, invoice_no: str) -> dict:
        """Upload one invoice to DS05 and submit a DS00 take-back CS.

        Mirrors the proven-working DS05/DS00 flow in
        ``backend/api/return_shipping_routes.py`` (반품배송 테스트). That
        version deliberately omits ``X-Requested-With`` on the file upload,
        keeps the DS00 request's Referer pointed at ``popup35.htm?template=DS05``
        (not the generic ``popup25.htm?template=DS00`` the shared ``post()``
        helper would use), and fills real receiver info - EZAdmin's response
        to a mismatched Referer/empty receiver looks enough like a login page
        to trip ``looks_like_session_error`` even when the session is fine.
        """
        value = str(invoice_no).strip()
        if not value:
            raise ValueError("invoice_no is required")
        import xlwt
        book = xlwt.Workbook()
        sheet = book.add_sheet("Sheet1")
        sheet.write(0, 0, "송장번호")
        sheet.write(1, 0, value)
        buf = io.BytesIO(); book.save(buf)
        phpsessid = self._phpsessid()
        upload_headers = {"User-Agent": "Mozilla/5.0",
                           "Referer": f"{config.EZADMIN_BASE}/popup35.htm?template=DS05&set_batch_cs=1"}
        async with httpx.AsyncClient(timeout=self._timeout, verify=False, follow_redirects=True) as client:
            upload_response = await client.post(
                f"{config.EZADMIN_BASE}/popup35.htm",
                data={"template": "DS05", "action": "update_batch_cs", "set_batch_cs": "1", "set_order_label": ""},
                files={"_file": ("return_invoice.xls", buf.getvalue(), "application/vnd.ms-excel")},
                cookies={"PHPSESSID": phpsessid}, headers=upload_headers)
            upload_body = (upload_response.text or "").strip()
            match = re.search(r"batch_cs_[A-Za-z0-9_]+", upload_body)
            if not match:
                if self.looks_like_session_error(upload_response, upload_body):
                    raise EzAdminSessionExpired("DS05 upload: session expired or invalid")
                raise RuntimeError(f"DS05 table name missing: {upload_body[:300]}")
            table_name = match.group(0)

            set_response = await client.post(
                f"{config.EZADMIN_BASE}/function.htm",
                data={"template": "DS00", "action": "set_batch_cs",
                      "work": "takeback", "table_name": table_name,
                      "cs_reason": "일반", "arr_product": "[]", "receiver_seq": "8",
                      "receiver_name": "유색", "receiver_tel1": "010", "receiver_tel2": "25466058",
                      "receiver_mobile1": "010", "receiver_mobile2": "25466058",
                      "receiver_zip1": "122", "receiver_zip2": "47",
                      "receiver_address": "경기 남양주시 진건읍 진관로303번길 9-1 (배양리) JH대리점",
                      "trans_who": "04", "trans_due_date": datetime.now().strftime("%Y-%m-%d"),
                      "timeFlag": self.time_flag("browser"),
                      "cs_content": "", "seq": "", "cancel_pack": "0", "recover_pack": "0",
                      "delete_pack": "0", "priority": "0", "auto_restockin_all": "0",
                      "auto_restockin_all_bad": "0", "restockin_ex": "0", "update_unhold": "0",
                      "unhold": "0", "set_cs_top_fix": "0"},
                cookies={"PHPSESSID": phpsessid},
                headers={"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest",
                         "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                         "Referer": f"{config.EZADMIN_BASE}/popup35.htm?template=DS05"})
        set_body = (set_response.text or "").strip()
        if self.looks_like_session_error(set_response, set_body):
            raise EzAdminSessionExpired("DS00 set_batch_cs: session expired or invalid")
        try:
            return set_response.json()
        except Exception as exc:
            raise EzAdminSessionExpired(f"DS00 set_batch_cs: non-JSON response: {set_body[:300]}") from exc

    async def _ezdesk_post(self, action: str, data: dict[str, Any], *, multipart: bool = False) -> dict:
        """POST an EZDesk A100 action using the stored PHPSESSID.

        ``httpx`` owns the multipart boundary. Callers should only provide
        fields; browser-only analytics cookies and sec-ch headers are not
        required for the authenticated function.php endpoint.
        """
        form = {"template": "A100", "action": action, **data}
        headers = {
            "Accept": "*/*",
            "Origin": config.EZDESK_BASE,
            "Referer": f"{config.EZDESK_BASE}/template2.html?template=A100",
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
        }
        request_files = {key: (None, value) for key, value in form.items()} if multipart else None
        request_data = None if multipart else form
        async with httpx.AsyncClient(timeout=self._timeout, verify=False, follow_redirects=True) as client:
            response = await client.post(
                f"{config.EZDESK_BASE}/function.php",
                data=request_data,
                files=request_files,
                cookies={"PHPSESSID": self._ezdesk_phpsessid()},
                headers=headers,
            )
        body = (response.text or "").strip()
        if self.looks_like_session_error(response, body):
            raise EzDeskSessionExpired(f"A100/{action}: session expired or invalid")
        try:
            return response.json()
        except Exception as exc:
            # A wrong/expired EZDesk PHPSESSID doesn't 404 or redirect to a
            # login page here - it returns HTTP 200 with a generic
            # "mysqli 데이터베이스에 연결할 수 없습니다" HTML body, which is
            # indistinguishable from a real DB outage except that a valid
            # EZDesk session against the same action returns proper JSON.
            # Treat any non-JSON response as an invalid EZDesk session so the
            # caller gets the same re-paste-cookie flow as the main EZAdmin
            # session instead of a confusing "database" error.
            raise EzDeskSessionExpired(
                f"A100/{action}: EZDesk 세션이 유효하지 않습니다 "
                f"(HTTP {response.status_code}, body={body[:200]!r})"
            ) from exc
