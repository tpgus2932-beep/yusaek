"""이지어드민 주문(E900) 검색·상세 조회와 배송지(주소) 변경.

HAR(검색.har / 주소변경.har)에서 확인한 호출을 그대로 따른다.
- query_json   : 주문번호(super_keyword)로 합포(pack) 목록 검색
- packlist_json: 합포의 상품 행. 각 행의 data_row(JSON)에 현재 배송정보 전체가 들어 있다
- change_deliv_info: 배송정보 변경. 주문자·수취인·메모 등 기존 값을 모두 함께 보내야 해서
  data_row의 현재 값을 그대로 채우고 주소·우편번호만 바꾼다.
"""
from __future__ import annotations

import html
import json
import re
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import httpx

EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_REFERER = f"{EZADMIN_BASE}/popup25.htm?template=E900"
_HEADERS = {"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest", "Referer": _REFERER}


class SessionExpired(Exception):
    """이지어드민이 JSON 대신 로그인 화면을 돌려줬다."""


def _time_flag() -> str:
    return str(int(time.time() * 1000))


async def _post(client: httpx.AsyncClient, phpsessid: str, data: dict):
    res = await client.post(
        f"{EZADMIN_BASE}/function.htm", data=data, cookies={"PHPSESSID": phpsessid}, headers=_HEADERS
    )
    try:
        return res.json()
    except Exception:
        raise SessionExpired("이지어드민 세션이 만료되었습니다.")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True)


def _tail(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return digits[-4:] if len(digits) >= 4 else ""


async def search_packs(
    phpsessid: str, keyword: str, *, days: int = 90, rows: int = 50, search_type: str = "0"
) -> list[dict]:
    """주문번호(기본)나 전화번호(search_type=6, 배송확인.har)로 합포 목록을 검색한다. 결과 행(cell)을 그대로 돌려준다."""
    today = datetime.now()
    par = (
        "pack=&history_seq=&date_type=collect_date"
        f"&start_date={(today - timedelta(days=days)).strftime('%Y-%m-%d')}&end_date={today.strftime('%Y-%m-%d')}"
        f"&date_period_sel=0&search_type={search_type}&keyword=&keyword1=&keyword2=&keyword3=&keyword4=&keyword5="
        f"&super_keyword={quote(keyword)}&order_status=-1&order_cs=0&query_trans_who=0&is_gift=0&work_type=0"
        "&labels_string=&checkbox_options_string="
    )
    async with _client() as client:
        obj = await _post(
            client,
            phpsessid,
            {
                "_search": "false", "nd": _time_flag(), "rows": str(rows), "page": "1", "sidx": "", "sord": "desc",
                "readonly": "T", "template": "E900", "action": "query_json", "par": par,
            },
        )
    if not isinstance(obj, dict) or "rows" not in obj:
        raise RuntimeError("이지어드민 검색 응답 형식이 달라요.")
    return [row.get("cell") or {} for row in obj["rows"]]


async def pack_rows(phpsessid: str, pack: str) -> list[dict]:
    """합포의 상품 행들. 각 행에 data_row(현재 배송정보 포함)를 풀어 'row' 로 붙여 돌려준다."""
    async with _client() as client:
        obj = await _post(
            client,
            phpsessid,
            {
                "_search": "false", "nd": _time_flag(), "rows": "500", "page": "1", "sidx": "", "sord": "",
                "readonly": "T", "template": "E900", "action": "packlist_json", "pack": str(pack),
                "stock": "0", "is_masking": "0", "timeFlag": _time_flag(),
            },
        )
    out = []
    for row in (obj.get("rows") if isinstance(obj, dict) else None) or []:
        cell = row.get("cell") or {}
        try:
            data = json.loads(cell.get("data_row") or "{}")
        except ValueError:
            data = {}
        out.append({"cell": cell, "row": data})
    return out


def describe_pack(pack: str, search_cell: dict, rows: list[dict], keyword: str) -> dict:
    """화면에 보여줄 합포 요약 (연락처는 뒷 4자리만)."""
    data = rows[0]["row"] if rows else {}
    return {
        "pack": str(pack),
        "order_id": search_cell.get("order_id", ""),
        "exact": str(search_cell.get("order_id", "")).strip() == keyword.strip(),
        "shop_name": search_cell.get("shop_name", ""),
        "collect_date": search_cell.get("collect_date", ""),
        "status": str(search_cell.get("status", "")),
        "hold": str(search_cell.get("hold", "") or "0"),
        "order_cs": str(search_cell.get("order_cs", "") or "0"),
        "recv_name": data.get("recv_name") or search_cell.get("recv_name", ""),
        "tel_tail": _tail(data.get("recv_tel2") or data.get("recv_tel1") or search_cell.get("recv_mobile", "")),
        "address": data.get("recv_add") or search_cell.get("recv_address", ""),
        "zip": data.get("recv_zip", ""),
        "memo": data.get("memo", ""),
        "trans_no": data.get("trans_no", "") or "",
        "trans_corp": data.get("trans_corp_name", "") or "",
        "shop_id": str(data.get("shop_id", "")),
        "items": [
            {
                "name": r["cell"].get("product_name", ""),
                "options": r["cell"].get("options", ""),
                "qty": r["cell"].get("qty", ""),
                "prd_seq": str(r["row"].get("prd_seq", "")),
                "product_id": str(r["row"].get("product_id", "")),
            }
            for r in rows
        ],
    }


def _strip_html(text) -> str:
    return re.sub(r"<[^>]*>|&nbsp;", " ", str(text or "")).strip()


async def search_products(phpsessid: str, name: str, shop_id: str, *, max_pages: int = 10) -> list[dict]:
    """상품교환 팝업(search_popup_product, 교환뜨빠.har)과 같은 검색. 상품명으로 옵션(상품코드) 목록을 모두 모은다."""
    found: list[dict] = []
    total = None
    async with _client() as client:
        for page in range(max_pages):
            obj = await _post(
                client,
                phpsessid,
                {
                    "readonly": "T", "template": "E900", "action": "search_popup_product", "name": name,
                    "query_type": "1", "query_string": "", "shop_id": str(shop_id), "page": str(page),
                    "auth_e3": "0", "is_pre_trans": "1", "timeFlag": _time_flag(),
                },
            )
            if not isinstance(obj, list) or not obj:
                break
            for r in obj:
                found.append({
                    "product_id": str(r.get("product_id", "")).strip(),
                    "name": _strip_html(r.get("name")),
                    "options": _strip_html(r.get("options")),
                    "supply": _strip_html(r.get("supply")),
                })
            total = obj[0].get("total_rows", total)
            if total is not None and len(found) >= int(total):
                break
    return found


_CS_TYPES = {"2": "보류 해제", "10": "취소", "12": "정상 복귀", "17": "상품 교환"}  # HAR(뜨빠/교환뜨빠)에서 확인한 값만
_KNOWN_TAGS = re.compile(r"</?(?:b|i|u|p|a|em|div|span|font|strong|img|table|tr|td)\b[^>]*>", re.IGNORECASE)


def _clean_cs_text(text) -> str:
    """CS 내용의 HTML을 글자로 바꾼다. '<본상품:(S1)…>' 처럼 꺾쇠로 쓴 값은 태그가 아니므로 남긴다."""
    out = re.sub(r"<br\s*/?>", "\n", str(text or ""), flags=re.IGNORECASE)
    out = _KNOWN_TAGS.sub("", out)
    return html.unescape(out).strip()


async def cs_history(phpsessid: str, pack: str) -> list[dict]:
    """합포의 C/S 이력 (get_cs_history). 이지어드민이 주는 순서(최신순)를 그대로 돌려준다."""
    async with _client() as client:
        obj = await _post(
            client, phpsessid,
            {"readonly": "T", "template": "E900", "action": "get_cs_history", "seq": str(pack), "cs_all": "true", "timeFlag": _time_flag()},
        )
    out = []
    for row in (obj.get("list") if isinstance(obj, dict) else None) or []:
        if str(row.get("is_delete", "0")) not in ("0", ""):
            continue
        cs_type = str(row.get("cs_type", ""))
        out.append({
            "id": str(row.get("id_seq", "")),
            "time": str(row.get("input_time", "")),
            "writer": str(row.get("writer") or ""),
            "type": cs_type,
            "type_name": _CS_TYPES.get(cs_type, f"CS({cs_type})" if cs_type else "CS"),
            "content": _clean_cs_text(row.get("content")),
            "reply": _clean_cs_text(row.get("res_content")),
            "reply_writer": str(row.get("res_writer") or ""),
        })
    return out


async def release_hold(phpsessid: str, pack: str) -> dict:
    """보류 해제 (cancel_hold, 뜨빠.har)."""
    async with _client() as client:
        return await _post(
            client, phpsessid,
            {"template": "E900", "action": "cancel_hold", "seq": str(pack), "timeFlag": _time_flag()},
        )


async def normal_pack(phpsessid: str, pack: str) -> dict:
    """주문 정상 복귀 (normal_pack, 뜨빠.har). 취소 등 CS 상태를 정상으로 되돌린다."""
    async with _client() as client:
        return await _post(
            client, phpsessid,
            {
                "template": "E900", "action": "normal_pack", "seq": str(pack),
                "cancel_re_ex": "0", "cancel_re": "0", "timeFlag": _time_flag(),
            },
        )


def build_change_params(data: dict, address: str, zip_code: str, pack: str) -> dict:
    """change_deliv_info 요청 값. 기존 값은 data_row 그대로 두고 주소·우편번호만 바꾼다."""
    def val(key: str) -> str:
        value = data.get(key, "")
        return "" if value is None else str(value)

    return {
        "template": "E900",
        "action": "change_deliv_info",
        "seq": str(pack),
        "order_seq": str(pack),
        "order_name": val("order_name"),
        "order_tel": val("order_tel1"),
        "order_mobile": val("order_tel2"),
        "name": val("recv_name"),
        "tel": val("recv_tel1"),
        "mobile": val("recv_tel2"),
        "address": address,
        "zip": zip_code,
        "memo": val("memo"),
        "gift": val("gift"),
        # data_row 는 '선불(0)' 처럼 금액이 붙어 있지만 요청에는 '선불'만 보낸다.
        "trans_who": re.sub(r"\(.*?\)$", "", val("trans_who")).strip(),
        "trans_fee": val("trans_fee"),
        "trans_due_date": val("trans_due_date"),
        "cross_change": val("cross_change"),
        "pre_trans": val("pre_trans"),
        "cs_type": "",
        "content": "",
        "code9": val("code9"),
    }


async def change_address(phpsessid: str, data: dict, address: str, zip_code: str, pack: str) -> dict:
    params = build_change_params(data, address, zip_code, pack)
    params["timeFlag"] = _time_flag()
    async with _client() as client:
        return await _post(client, phpsessid, params)
