from __future__ import annotations

import sqlite3
from pathlib import Path


def search_cost_base_products(path: Path, q: str, limit: int = 20) -> list[dict]:
    """원가베이스유 DB(wonbe 테이블)에서 상품명 또는 거래처상품명으로 검색해
    옵션(색상/사이즈/옵션번호/상품코드)을 묶어 반환.

    DB Manager의 원가베이스 화면과 동일하게 원가베이스유.db를 직접 조회한다
    (예전에는 별도로 내보낸 원가베이스유.xlsx 스냅샷을 읽었는데, 그 파일을
    수동으로 다시 내보내지 않으면 최근 등록 상품이 검색에 안 뜨는 문제가 있었다).

    같은 상품명의 색상/사이즈별 행들을 하나의 항목으로 묶고, 그 항목의
    options에 {code, label, product_id}를 순서대로 모은다. 검색어는
    상품명·거래처상품명 둘 중 아무 곳에나 일치해도 매칭되지만, 결과는
    항상 상품명(에이블리 goods_name 검색에 쓰이는 값) 기준으로 묶인다.
    - code: 옵션번호 (에이블리 goods_option_sno와 동일, 취소/미진열 API에 사용)
    - label: "색상/사이즈" 표시용 라벨 (실행 화면에서 옵션을 개별 선택/해제하는 데 사용)
    - product_id: 상품코드 (EZAdmin I100 재고조회에서 "접수" 잔여 수량을 조회하는 데 사용)
    """
    if not path.exists():
        return []

    q_norm = (q or "").strip().lower()
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT 상품코드, 상품명, 색상, 사이즈, 거래처상품명, 옵션번호 FROM wonbe"
        ).fetchall()
    finally:
        conn.close()

    groups: dict[str, list[dict]] = {}
    seen_codes: dict[str, set[str]] = {}
    order: list[str] = []
    for row in rows:
        name = str(row["상품명"] or "").strip()
        supplier_name = str(row["거래처상품명"] or "").strip()
        option_code = str(row["옵션번호"] or "").strip()
        if not name or not option_code:
            continue
        if q_norm and q_norm not in name.lower() and q_norm not in supplier_name.lower():
            continue
        if name not in groups:
            groups[name] = []
            seen_codes[name] = set()
            order.append(name)
        if option_code in seen_codes[name]:
            continue
        seen_codes[name].add(option_code)
        color = str(row["색상"] or "").strip()
        size = str(row["사이즈"] or "").strip()
        label = "/".join(part for part in (color, size) if part) or option_code
        product_id = str(row["상품코드"] or "").strip()
        groups[name].append({"code": option_code, "label": label, "product_id": product_id})

    return [{"name": name, "options": groups[name]} for name in order[:limit]]


def filter_matching_order_items(order_items: list[dict], option_codes: set[str]) -> list[dict]:
    """order_items 중 option_stock_sync_code가 option_codes에 속하는 것만 남긴다."""
    return [
        item for item in order_items
        if str(item.get("option_stock_sync_code") or "") in option_codes
    ]


def group_items_by_order_sno(items: list[dict]) -> dict[int, list[dict]]:
    """주문상품 리스트를 order_sno 기준으로 그룹핑 (취소 API가 주문당 1회 호출이라 필요)."""
    grouped: dict[int, list[dict]] = {}
    for item in items:
        grouped.setdefault(item["order_sno"], []).append(item)
    return grouped


def build_soldout_message(template_msg: str, product_names: list[str]) -> str:
    """템플릿의 {상품}을 실제 상품명으로 치환. 중복 상품명은 제거하고 쉼표로 나열."""
    unique_names = list(dict.fromkeys(product_names))
    return template_msg.replace("{상품}", ", ".join(unique_names))
