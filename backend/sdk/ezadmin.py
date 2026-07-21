from __future__ import annotations

from datetime import datetime
from typing import Any
import io
import re
import httpx
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

    async def post(self, template: str, action: str, *, data: dict[str, Any] | None = None, par: str | None = None, files=None, time_flag: str | None = "browser", extra_headers: dict[str, str] | None = None) -> dict:
        form: dict[str, Any] = {"template": template, "action": action, **(data or {})}
        if par is not None: form["par"] = par
        if time_flag: form.setdefault("timeFlag", self.time_flag(time_flag))
        headers = {"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest", "Referer": f"{config.EZADMIN_BASE}/popup25.htm?template={template}", **(extra_headers or {})}
        async with httpx.AsyncClient(timeout=self._timeout, verify=False, follow_redirects=True) as client:
            response = await client.post(f"{config.EZADMIN_BASE}/function.htm", data=form, files=files, cookies={"PHPSESSID": self._phpsessid()}, headers=headers)
        body = (response.text or "").strip()
        if self.looks_like_session_error(response, body): raise EzAdminSessionExpired(f"{template}/{action}: session expired or invalid")
        try: return response.json()
        except Exception as exc: raise EzAdminSessionExpired(f"{template}/{action}: non-JSON response") from exc

    async def query_orders(self, super_keyword: str, *, start_date: str, end_date: str, rows: int = 10) -> list[dict]:
        par = f"pack=&history_seq=&date_type=collect_date&start_date={start_date}&end_date={end_date}&date_period_sel=0&search_type=0&keyword=&keyword1=&keyword2=&keyword3=&keyword4=&keyword5=&super_keyword={super_keyword}&order_status=-1&order_cs=0&query_trans_who=0&is_gift=0&work_type=0&labels_string=&checkbox_options_string="
        data = await self.post("E900", "query_json", data={"_search": "false", "rows": str(rows), "page": "1", "sidx": "", "sord": "desc", "readonly": "T"}, par=par, time_flag="epoch_ms")
        return data.get("rows") or []

    async def packlist(self, pack: str) -> dict:
        return await self.post("E900", "packlist_json", data={"_search": "false", "rows": "500", "page": "1", "sidx": "", "sord": "", "readonly": "T", "pack": pack, "stock": "0", "is_masking": "0"}, time_flag="epoch_ms")

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

    async def cancel_trans(self, seq: str) -> dict:
        return await self.post("E900", "cancel_trans", data={"seq": seq, "content": ""}, time_flag="epoch_ms")

    async def delete_trans_no(self, seq: str) -> dict:
        return await self.post("E900", "delete_trans_no", data={"seq": seq, "content": ""}, time_flag="epoch_ms")

    async def set_stock_data(self, product_id: str, qty: int, *, type_: str = "out", bad: str = "0") -> dict:
        return await self.post("I100", "set_stock_data", data={"product_id": product_id, "bad": bad, "type": type_, "stock_label": "", "move_warehouse": "0", "stock_unit": "stock_unit_ea", "qty": str(qty), "memo": ""}, time_flag="browser")

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
