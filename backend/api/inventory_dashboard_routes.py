from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = timezone(timedelta(hours=9))
_PAGE_ROWS = 100
_TABLE = "inventory_dashboard_stock"

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_INPUT_VALUE_RE = re.compile(r"""value\s*=\s*['"]?([^'"\s>]*)""")

_COLUMNS = (
    "code", "product_name", "options", "brand", "supply_name", "barcode",
    "stock_qty", "before_trans", "stock_in_standby", "trans_ready", "org_price", "fetched_at",
)


def _strip_html(value) -> str:
    """EZAdmin 그리드 셀은 종종 값이 <a onclick=...><span>123</span></a> 형태의
    HTML로 내려온다 (예: 재고수량 클릭 시 상세 팝업을 여는 링크). 태그를 걷어내고
    표시용 텍스트만 남긴다."""
    return _HTML_TAG_RE.sub("", str(value or "")).strip()


def _input_value(value) -> str:
    """<input ... value='0'> 형태 셀에서 value 속성만 꺼낸다."""
    m = _INPUT_VALUE_RE.search(str(value or ""))
    return m.group(1) if m else _strip_html(value)


def _to_int(value) -> int:
    try:
        return int(float(str(value).replace(",", "").strip() or 0))
    except ValueError:
        return 0


def init_inventory_dashboard_tables(get_db) -> None:
    conn = get_db()
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {_TABLE} (
            code TEXT NOT NULL,
            product_name TEXT,
            options TEXT,
            brand TEXT,
            supply_name TEXT,
            barcode TEXT,
            stock_qty INTEGER,
            before_trans INTEGER,
            stock_in_standby INTEGER,
            trans_ready INTEGER,
            org_price INTEGER,
            fetched_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def _build_par(today: str) -> str:
    # sdafsdafsdaffds.har (이지어드민 재고 I100 검색) 에서 캡처한 조건 그대로.
    return (
        "auto_search=&search_all_product=&multi_supply_group=&multi_supply=&str_supply_code=0"
        "&tags_string=&product_tag_include_type=1&query_type=name&query_str="
        "&stock_type=0&stock_start=1&stock_end=&notrans_day=&notrans_cnt=&notrans_status=0&stock_status=0"
        f"&start_date={today}&start_hour=00%3A00%3A00&end_date={today}&end_hour=23%3A59%3A59"
        "&date_period_sel=1&work_type=stockin&work_start=&work_end=&inout_type=0&product_date="
        f"&start_date2={today}&end_date2={today}&date_period_sel2=1"
        "&products_sort=1&category=0&except_soldout=0&temp_soldout=0&location=0"
    )


def _row_to_record(cell: dict, normalize_to_yusas, fetched_at: str):
    raw_code = cell.get("key") or _strip_html(cell.get("product_id"))
    code = normalize_to_yusas(raw_code) or str(raw_code).strip()
    if not code:
        return None
    return (
        code,
        _strip_html(cell.get("product_name")),
        _strip_html(cell.get("options")),
        _strip_html(cell.get("brand")),
        _strip_html(cell.get("supply_name")),
        _strip_html(cell.get("barcode")),
        _to_int(_strip_html(cell.get("stock"))),
        _to_int(_strip_html(cell.get("before_trans"))),
        _to_int(_input_value(cell.get("stock_in_standby"))),
        _to_int(_strip_html(cell.get("trans_ready"))),
        _to_int(cell.get("org_price")),
        fetched_at,
    )


def _read_all(get_db):
    conn = get_db()
    try:
        rows = conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM {_TABLE} ORDER BY code"
        ).fetchall()
    finally:
        conn.close()
    return [{col: r[col] for col in _COLUMNS} for r in rows]


def build_inventory_dashboard_router(
    *,
    get_current_user,
    get_setting,
    normalize_to_yusas,
    get_db,
    allow_refresh: bool = True,
):
    router = APIRouter(prefix="/inventory-dashboard", tags=["inventory-dashboard"])

    @router.get("/stock")
    async def get_stock(user: str = Depends(get_current_user)):
        items = _read_all(get_db)
        return {
            "ok": True,
            "items": items,
            "fetched_at": items[0]["fetched_at"] if items else None,
            "can_refresh": allow_refresh,
        }

    @router.post("/refresh")
    async def refresh_stock(user: str = Depends(get_current_user)):
        """이지어드민 재고(I100)를 HAR 조건으로 전 페이지 조회 → 기존 데이터 삭제 후 DB에 새로 저장."""
        if not allow_refresh:
            raise HTTPException(status_code=403, detail="배포 환경에서는 조회할 수 없습니다. 로컬에서 조회해 주세요.")
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        now = datetime.now(_KST)
        today = now.strftime("%Y-%m-%d")
        fetched_at = now.isoformat()
        par = _build_par(today)

        cells: list[dict] = []
        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                page, total_pages = 1, 1
                while page <= total_pages:
                    r = await client.post(
                        f"{_EZADMIN_BASE}/function.htm",
                        data={
                            "_search": "false", "nd": str(int(datetime.now().timestamp() * 1000)),
                            "rows": str(_PAGE_ROWS), "page": str(page), "sidx": "", "sord": "asc",
                            "template": "I100", "action": "search", "page_code": "I100",
                            "par": par,
                        },
                        cookies={"PHPSESSID": phpsessid},
                        headers={
                            "User-Agent": "Mozilla/5.0",
                            "X-Requested-With": "XMLHttpRequest",
                            "Referer": f"{_EZADMIN_BASE}/template35.htm?template=I100",
                        },
                    )
                    try:
                        obj = r.json()
                    except Exception:
                        # 세션 만료 시 JSON 대신 로그인 HTML이 내려온다.
                        return {"ok": False, "need_session": True, "raw_preview": r.text[:1000]}
                    if not isinstance(obj, dict) or "rows" not in obj:
                        return {"ok": False, "unexpected_response": True, "raw": obj}
                    cells.extend((row.get("cell") or {}) for row in obj["rows"])
                    total_pages = _to_int(obj.get("total")) or 1
                    page += 1
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 연결 실패: {exc}")

        records = [
            rec for rec in (_row_to_record(c, normalize_to_yusas, fetched_at) for c in cells) if rec
        ]

        # 조회가 모두 성공한 뒤에만 교체한다 (실패 시 기존 데이터 유지).
        conn = get_db()
        try:
            conn.execute(f"DELETE FROM {_TABLE}")
            conn.executemany(
                f"INSERT INTO {_TABLE} ({', '.join(_COLUMNS)}) VALUES ({', '.join('?' * len(_COLUMNS))})",
                records,
            )
            conn.commit()
        finally:
            conn.close()

        return {"ok": True, "date": today, "count": len(records), "fetched_at": fetched_at}

    return router
