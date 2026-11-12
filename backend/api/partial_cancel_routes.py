"""부분취소 보류해제 (관리페이지(승일방)에서 옮겨온 기능).

이지어드민 확장자주문검색2에서 최근 3개월 · C/S=부분취소 · 보류 주문을 찾아
C/S일괄처리 > 선택처리 > 보류해제를 실행한다. 세션은 app_settings의 ezadmin_phpsessid를 쓴다.
"""
from __future__ import annotations

import calendar
import http.client
import json
import logging
import re
import threading
import urllib.parse
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

KST = timezone(timedelta(hours=9))

_EZADMIN_HOST = "https://ga80.ezadmin.co.kr"
_EZADMIN_FUNCTION_PATH = "/function.htm"
_EZADMIN_DOMAIN = "yusaek"
_SESSION_SETTING_KEY = "ezadmin_phpsessid"
_REQUEST_TIMEOUT_SEC = 20

PAGE_SIZE = 100
MAX_PAGES = 50
_SEQ_RE = re.compile(r"seq='(\d+)'")


class EzadminSessionExpired(Exception):
    pass


class EzadminError(Exception):
    pass


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")


class _EzadminClient:
    """이지어드민 function.htm 호출 래퍼. 한 작업 안에서는 연결을 재사용한다."""

    def __init__(self, phpsessid: str):
        self._cookie = f"PHPSESSID={phpsessid}; ezdomain={_EZADMIN_DOMAIN}; ezuserid={_EZADMIN_DOMAIN}"
        self._conn = None

    def call(self, form: dict) -> dict:
        form = {**form, "timeFlag": str(int(datetime.now().timestamp() * 1000))}
        body = urllib.parse.urlencode(form).encode("utf-8")
        headers = {
            "Cookie": self._cookie,
            "Referer": f"{_EZADMIN_HOST}/popup25.htm?template=E900&_si=161",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        netloc = urllib.parse.urlsplit(_EZADMIN_HOST).netloc
        text = None
        for attempt in (1, 2):
            if self._conn is None:
                self._conn = http.client.HTTPSConnection(netloc, timeout=_REQUEST_TIMEOUT_SEC)
            try:
                self._conn.request("POST", _EZADMIN_FUNCTION_PATH, body, headers)
                res = self._conn.getresponse()
                raw = res.read()
                if res.status >= 400:
                    raise EzadminError(f"이지어드민 응답 오류 {res.status}")
                text = _decode(raw)
                break
            except EzadminError:
                raise
            except (OSError, http.client.HTTPException) as exc:
                # 서버가 유휴 연결을 끊었으면 한 번 새 연결로 다시 시도한다.
                self._conn = None
                if attempt == 2:
                    raise EzadminError(f"이지어드민 연결 실패: {exc!r}") from exc
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            # 세션이 없으면 JSON 대신 로그인 HTML이 내려온다.
            raise EzadminSessionExpired() from exc


def _check_error(result: dict, step: str):
    if str(result.get("error", 0)) != "0":
        raise EzadminError(f"{step} 실패: {result}")


def three_months_range(today: date) -> tuple[date, date]:
    """이지어드민 '최근세달'(date_period_sel=9)과 같은 기간: 오늘 기준 3개월 전 + 1일 ~ 오늘."""
    month = today.month - 3
    year = today.year
    if month < 1:
        month += 12
        year -= 1
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(today.day, last_day)) + timedelta(days=1), today


def _search_par(start, end, page: int) -> str:
    # 확장자주문검색2: C/S=부분취소(order_cs_sel=13), 카테고리 조건=보류(hold_order)
    pairs = [
        ("template", "DS00"), ("action", ""), ("search", "1"), ("page", str(page)),
        ("_sort", ""), ("sort_order", ""), ("panel_open", "true"), ("field_change", ""),
        ("bck_search", "0"), ("recover_delete", ""),
        ("date_type", "collect_date"), ("start_date", start.isoformat()), ("start_hour", "00"),
        ("end_date", end.isoformat()), ("end_hour", "23"), ("date_period_sel", "9"),
        ("option[]", "seq"), ("query_str[]", ""),
        ("multi_supply_group", ""), ("multi_supply", ""), ("str_supply_code", "0"),
        ("status_sel", "0"), ("pack_sel", "0"), ("check_set_match", "0"),
        ("order_cs_sel", "13"), ("work_type", "0"),
        ("checkbox_options_string", "hold_order"), ("checkbox_options", "hold_order"),
        ("trans_corp", "99"), ("user_area", ""),
        ("multi_shop_group", ""), ("multi_shop", ""), ("str_shop_code", "0"),
        ("tags_string", ""), ("product_tag_include_type", "1"),
        ("labels_string", ""), ("order_label_include_type", "1"),
        ("date_type2", "0"), ("start_date2", end.isoformat()), ("start_hour2", "00"),
        ("end_date2", end.isoformat()), ("end_hour2", "23"), ("date_period_sel2", "0"),
        ("category", "0"), ("option[]", ""), ("query_str[]", ""), ("c_cs", "blink"),
        ("order_copy", "0"), ("create_order", "0"), ("print_enable", "0"), ("product_expect", "0"),
        ("return_money_expect_price", ""), ("return_money_return_price", ""),
        ("trans_who", "0"), ("cs_reason", ""), ("multi_user_cs_type", ""), ("user_cs_type", "0"),
        ("select_field", "DS00_1"), ("download_field", "DS00_file"), ("download_type", "0"),
        ("include_sum", "on"),
    ]
    return urllib.parse.urlencode(pairs)


def search_hold_orders(client: _EzadminClient) -> list[dict]:
    """확장자주문검색2에서 최근 3개월 / C/S=부분취소 / 카테고리 조건=보류 주문을 모두 찾는다."""
    start, today = three_months_range(datetime.now(KST).date())
    orders: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        result = client.call({
            "_search": "false", "rows": str(PAGE_SIZE), "page": str(page), "sidx": "", "sord": "asc",
            "template": "DS00", "action": "grid_DS00", "bck_search": "0",
            "par": _search_par(start, today, page),
        })
        rows = result.get("rows") or []
        for row in rows:
            cell = row["cell"]
            match = _SEQ_RE.search(cell.get("chk", ""))
            if not match:
                continue
            orders.append({
                "seq": match.group(1), "orderSeq": cell.get("org_seq"),
                "shop": cell.get("shop_id"), "orderId": cell.get("order_id"),
                "recvName": cell.get("recv_name"), "name": cell.get("name"),
                "option": cell.get("p_options"), "qty": cell.get("qty"),
            })
        if len(rows) < PAGE_SIZE:
            break
    return orders


def _register_selection(client: _EzadminClient, orders: list[dict]) -> str:
    """선택한 주문을 일괄처리 대상으로 등록하고 임시 테이블명을 돌려준다."""
    result = client.call({
        "template": "DS00", "action": "set_seq_list",
        "seq_list": ",".join(o["seq"] for o in orders),
    })
    _check_error(result, "선택 주문 등록")
    table_name = result.get("table_name")
    if not table_name:
        raise EzadminError(f"선택 주문 등록 응답에 table_name이 없습니다: {result}")
    return table_name


def release_hold(client: _EzadminClient, orders: list[dict]) -> dict:
    """C/S일괄처리 > 선택처리 > 보류해제를 실행하고, 다시 검색해 실제로 풀렸는지 확인한다."""
    table_name = _register_selection(client, orders)
    today = datetime.now(KST).date().isoformat()
    _check_error(
        client.call({
            "template": "DS00", "action": "set_batch_cs", "work": "unhold",
            "cancel_pack": "0", "recover_pack": "0", "delete_pack": "0", "priority": "0",
            "auto_restockin_all": "0", "auto_restockin_all_bad": "0", "restockin_ex": "0",
            "cs_reason": "일반", "cs_content": "", "table_name": table_name, "arr_product": "[]",
            "update_unhold": "0", "unhold": "0",
            "unhold_date_date": today, "unhold_date_hour": "00", "unhold_date_minute": "00",
            "seq": "", "trans_who": "04", "trans_due_date": today, "change_order_date": today,
            "change_trans_info_zip1": "", "change_trans_info_zip2": "", "change_trans_info_address": "",
            "search_code23": "", "set_cs_top_fix": "0",
        }),
        "보류해제",
    )
    remaining = len(search_hold_orders(client))
    if remaining:
        raise EzadminError(f"보류해제를 실행했지만 {remaining}건이 아직 보류 상태입니다. 이지어드민에서 확인해주세요.")
    return {"released": len(orders), "orders": orders}


def build_partial_cancel_router(*, get_current_user, get_setting):
    router = APIRouter(prefix="/partial-cancel", tags=["partial-cancel"])
    lock = threading.Lock()

    def _client() -> _EzadminClient:
        phpsessid = get_setting(_SESSION_SETTING_KEY)
        if not phpsessid:
            raise HTTPException(status_code=409, detail="session_expired")
        return _EzadminClient(phpsessid)

    def _run(fn):
        try:
            return fn()
        except HTTPException:
            raise
        except EzadminSessionExpired:
            raise HTTPException(status_code=409, detail="session_expired")
        except EzadminError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:  # noqa: BLE001
            logging.exception("partial cancel failed")
            raise HTTPException(status_code=500, detail=f"서버 오류: {exc!r}")

    @router.get("/preview")
    def preview(current_user=Depends(get_current_user)):
        """실행 전 대상 주문만 조회한다. 이지어드민 데이터는 바뀌지 않는다."""
        with lock:
            orders = _run(lambda: search_hold_orders(_client()))
        return {"count": len(orders), "orders": orders}

    @router.post("/run")
    def run(current_user=Depends(get_current_user)):
        with lock:
            def work():
                client = _client()
                orders = search_hold_orders(client)
                if not orders:
                    return {"count": 0, "released": 0, "orders": []}
                return {"count": len(orders), **release_hold(client, orders)}
            return _run(work)

    return router
