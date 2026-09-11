from __future__ import annotations

import asyncio
import re
from datetime import datetime
from io import BytesIO

import httpx
import pandas as pd

from sdk import config
from sdk.ezadmin import EzAdminClient

# 실제 품목 라인(품목명/수량) 다운로드 컬럼 배치는 NoyeKimPage.jsx의
# convertCurrentReceiptExcelRowsSplitV3가 이미 확인해둔 것과 동일하게 맞춘다:
# 0열=거래처+상품명, 2열=원 발주(입고) 수량. 헤더 행(0번째 행)은 건너뛴다.
_NAME_COL = 0
_QTY_COL = 2
_MAX_POLL_ATTEMPTS = 30
_POLL_INTERVAL_SEC = 2


def _clean_cell(value) -> str:
    if not isinstance(value, str):
        return value
    return re.sub(r"<[^>]+>", "", value).strip()


async def fetch_im00_vouchers(get_setting, *, date: str) -> list[dict]:
    """지정일의 이지어드민 IM00(입고요청) 전표 목록을 [{sheet, cell}] 형태로 반환."""
    ez = EzAdminClient(get_setting)
    data = await ez.post(
        "IM00",
        "get_IM00_grid",
        data={
            "_search": "false",
            "nd": str(int(datetime.now().timestamp() * 1000)),
            "rows": "9999",
            "page": "1",
            "sidx": "",
            "sord": "asc",
        },
        par=(
            "template=IM00&action=&page_code=IM00&search=1"
            "&_sort=&sort_order=&date_type=crdate"
            f"&start_date={date}&end_date={date}"
            "&date_period_sel=0&query_option=title&query_str=&req_status=0"
        ),
    )
    vouchers: list[dict] = []
    for row in data.get("rows", []) or []:
        cell = row.get("cell", {}) or {}
        sheet_no = str(cell.get("sheet") or "").strip()
        if not sheet_no:
            for val in cell.values():
                if isinstance(val, str) and "sheet=" in val:
                    m = re.search(r"sheet=['\"]?(\w+)['\"]?", val, re.IGNORECASE)
                    if m:
                        sheet_no = m.group(1)
                        break
        if not sheet_no:
            continue
        clean = {k: _clean_cell(v) for k, v in cell.items()}
        vouchers.append({"sheet": sheet_no, "cell": clean})
    return vouchers


async def fetch_im00_line_items(get_setting, *, sheet: str, date: str) -> list[dict]:
    """전표 하나(sheet)의 품목 라인을 다운로드해 [{name, qty}]로 반환.

    이지어드민 다운로드 워크플로(작업등록 -> BL30 폴링 -> 파일 다운로드)를 그대로
    거치므로 최대 1분 가까이 걸릴 수 있다. 세션이 없거나 만료되면
    EzAdminSessionExpired가 그대로 전파된다.
    """
    ez = EzAdminClient(get_setting)

    par = (
        "template=IM00&action=save_file_IM00&filename=&page_code=IM10_file"
        f"&sheet_list={sheet}&download_type=1&select_code=IM00_file"
        f"&date_type=crdate&start_date={date}&end_date={date}&date_period_sel="
        "&multi_supply_group=undefined&multi_supply=undefined&str_supply_code=undefined"
        "&sub_domain_seq=undefined&req_status=0&query_option=title&query_str=&readonly=T"
    )
    await ez.post(
        "download",
        "ins_download_worklist",
        data={"work_template": "IM00", "work_func": "save_file_IM00"},
        par=par,
        extra_headers={"X-Requested-With": "XMLHttpRequest"},
        require_json=False,
    )

    file_url = None
    for _ in range(_MAX_POLL_ATTEMPTS):
        await asyncio.sleep(_POLL_INTERVAL_SEC)
        bl = await ez.post(
            "BL30",
            "grid_BL30",
            data={
                "_search": "false",
                "nd": str(int(datetime.now().timestamp() * 1000)),
                "rows": "300",
                "page": "1",
                "sidx": "",
                "sord": "desc",
            },
            par=(
                "template=BL30&action=&bck_search="
                f"&start_date={date}&start_hour=00%3A00%3A00"
                f"&end_date={date}&end_hour=23%3A59%3A59"
                "&date_period_sel=0"
            ),
        )
        for row in bl.get("rows", []) or []:
            cell = row.get("cell", {}) or {}
            if cell.get("template") == "입고요청전표2" and cell.get("status") == "완료":
                file_url = cell.get("file_name")
                break
        if file_url:
            break

    if not file_url:
        raise RuntimeError(f"전표 {sheet}: 완료된 다운로드 파일을 찾지 못했습니다.")

    phpsessid = str(get_setting(config.EZADMIN_SESSION_KEY) or "").strip()
    async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
        r = await client.get(file_url, cookies={"PHPSESSID": phpsessid})
        r.raise_for_status()

    try:
        dataframe = pd.read_excel(BytesIO(r.content), header=None, engine="xlrd")
    except Exception:
        dataframe = pd.read_excel(BytesIO(r.content), header=None)

    items: list[dict] = []
    # 0번째 행은 헤더(품목명/옵션/수량 등 컬럼명)이므로 건너뛴다.
    for values in dataframe.iloc[1:].itertuples(index=False, name=None):
        if len(values) <= max(_NAME_COL, _QTY_COL):
            continue
        name = str(values[_NAME_COL] or "").strip()
        if not name or "합계" in name:
            continue
        try:
            qty = int(float(values[_QTY_COL]))
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        items.append({"name": name, "qty": qty})
    return items
