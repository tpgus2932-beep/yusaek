"""이지어드민 재고 상세 팝업(I104)의 '대기 주문 목록' 파싱과 판매처별 순번 계산.

I104 팝업은 옵션(상품코드)별로 발주 접수·송장 접수 상태인 주문을 최신순으로 보여주고,
각 행에 수량과 누적수량(모든 판매처 합산), 배송가능 여부를 붙인다.
"""
from __future__ import annotations

import re

EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
DEFAULT_SELLER = "에이블리(유색)"

_TAG = re.compile(r"<[^>]+>")
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)


def popup_url(product_code: str) -> str:
    # sum / stock 값은 결과에 영향이 없고, product_id 와 status=1(대기 주문)만 필요하다.
    return f"{EZADMIN_BASE}/popup35.htm?template=I104&product_id={product_code}&status=1"


def _text(cell_html: str) -> str:
    return re.sub(r"\s+", " ", _TAG.sub("", cell_html)).replace("&nbsp;", " ").strip()


def _to_int(value) -> int:
    try:
        return int(str(value).replace(",", "").strip())
    except ValueError:
        return 0


def parse_waiting_orders(html: str) -> dict:
    """{"stock": int|None, "orders": [...]} 를 돌려준다. 표를 찾지 못하면 ValueError(세션 만료 등)."""
    marker = html.find("wrap_form_table")
    if marker < 0:
        raise ValueError("대기 주문 표를 찾지 못했어요. 이지어드민 세션이 만료됐을 수 있어요.")
    body = re.sub(r"<script.*?</script>", "", html[marker:], flags=re.S)
    stock = None
    orders = []
    for tr in _ROW.findall(body):
        cells = [_text(c) for c in _CELL.findall(tr)]
        if stock is None and len(cells) >= 4 and cells[2] == "재고":
            match = re.match(r"-?\d[\d,]*", cells[3])
            stock = _to_int(match.group(0)) if match else 0
        # 관리번호, 발주일, 판매처, 주문번호, 판매처상품명, 주문자 id, 고객명, 연락처, 수량, 누적수량, 배송가능
        if len(cells) == 11 and cells[0].isdigit():
            orders.append(
                {
                    "mgmt_no": int(cells[0]),
                    "ordered_at": cells[1],
                    "seller": cells[2],
                    "order_no": cells[3],
                    "qty": _to_int(cells[8]),
                    "cum_qty": _to_int(cells[9]),
                    "deliverable": cells[10],
                }
            )
    return {"stock": stock, "orders": orders}


def rank_order(orders: list[dict], order_no: str, seller: str = DEFAULT_SELLER) -> dict:
    """같은 판매처 주문만 오래된 순(발주일, 관리번호)으로 세어 order_no 가 몇 번째인지 구한다."""
    pool = sorted((o for o in orders if o["seller"] == seller), key=lambda o: (o["ordered_at"], o["mgmt_no"]))
    wanted = str(order_no or "").strip()
    wanted_digits = re.sub(r"\D", "", wanted)
    index = next((i for i, o in enumerate(pool) if o["order_no"] == wanted), None)
    if index is None and wanted_digits:
        index = next((i for i, o in enumerate(pool) if re.sub(r"\D", "", o["order_no"]) == wanted_digits), None)
    result = {
        "seller": seller,
        "total": len(pool),
        "total_qty": sum(o["qty"] for o in pool),
        "all_total": len(orders),
        "found": index is not None,
    }
    if index is None:
        return result
    row = pool[index]
    result.update(
        {
            "rank": index + 1,
            "qty": row["qty"],
            "seller_cum_qty": sum(o["qty"] for o in pool[: index + 1]),  # 이 주문까지 같은 판매처 누적 수량
            "all_cum_qty": row["cum_qty"],  # 이지어드민이 보여주는 전체 판매처 누적 수량
            "deliverable": row["deliverable"],
            "ordered_at": row["ordered_at"],
            "order_no": row["order_no"],
        }
    )
    return result
