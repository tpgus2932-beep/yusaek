"""CS 문의 상품 ↔ DB관리 '원가베이스유'(wonbe) 매칭.

상품: 수동 연결 → 에이블리상품번호 일치 → 괄호 제거한 상품명 일치 순서로 찾는다.
옵션: 수동 연결 → 옵션번호 일치 → 옵션 토큰(색상·사이즈) 일치 순서로 찾는다.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Optional

_BRACKETS = re.compile(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)|\{[^}]*\}")
_SOFT_TOKENS = {"기본"}  # 기장 '기본'은 원가베이스에 있거나 없을 수 있어 2차 비교에서 제외한다.


def clean_name(name: str) -> str:
    """상품명에서 [ ] 【 】 ( ) { } 괄호와 그 안의 내용을 제거한다."""
    return re.sub(r"\s+", " ", _BRACKETS.sub(" ", name or "")).strip()


def norm_name(name: str) -> str:
    return re.sub(r"\s+", "", clean_name(name)).lower()


def option_tokens(parts) -> list[str]:
    """옵션 문자열 목록(또는 하나의 문자열)을 비교용 토큰으로 바꾼다. 순서는 무시한다."""
    if isinstance(parts, str):
        parts = [parts]
    tokens: list[str] = []
    for part in parts or []:
        for token in re.split(r"[\s/,]+", str(part or "")):
            token = token.strip().lower()
            if token:
                tokens.append(token)
    return sorted(tokens)


def option_key(parts) -> str:
    return "|".join(option_tokens(parts))


def _to_number(value) -> Optional[float]:
    digits = re.sub(r"[^\d.]", "", str(value or ""))
    try:
        return float(digits) if digits else None
    except ValueError:
        return None


class CostBase:
    """원가베이스 행들을 조회용으로 색인한다."""

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.by_ably: dict[str, list[dict]] = defaultdict(list)
        self.by_norm: dict[str, list[dict]] = defaultdict(list)
        self.by_name: dict[str, list[dict]] = defaultdict(list)
        self.by_code: dict[str, dict] = {}
        for row in rows:
            ably = str(row.get("에이블리상품번호") or "").strip()
            name = str(row.get("상품명") or "").strip()
            if ably:
                self.by_ably[ably].append(row)
            if name:
                self.by_name[name].append(row)
                self.by_norm[norm_name(name)].append(row)
            code = str(row.get("상품코드") or "").strip()
            if code:
                self.by_code[code] = row

    # ---- 상품 ----
    def product_rows(self, goods_sno, name: str, manual_base_name: str = "") -> tuple[str, list[dict]]:
        """(방법, 원가베이스 행들). 못 찾으면 ('', [])."""
        if manual_base_name and manual_base_name in self.by_name:
            return "manual", self.by_name[manual_base_name]
        if goods_sno and str(goods_sno) in self.by_ably:
            return "id", self.by_ably[str(goods_sno)]
        key = norm_name(name)
        if key and key in self.by_norm:
            return "name", self.by_norm[key]
        return "", []

    @staticmethod
    def summarize(rows: list[dict]) -> dict:
        names = Counter(str(r.get("상품명") or "").strip() for r in rows)
        suppliers = [s for s, _ in Counter(str(r.get("거래처") or "").strip() for r in rows).most_common() if s]
        costs = [c for c in (_to_number(r.get("원가")) for r in rows) if c is not None]
        return {
            "base_name": names.most_common(1)[0][0] if names else "",
            "suppliers": suppliers[:3],
            "cost_min": int(min(costs)) if costs else None,
            "cost_max": int(max(costs)) if costs else None,
            "option_count": len(rows),
        }

    def search_products(self, query: str, limit: int = 30) -> list[dict]:
        terms = [t for t in re.split(r"\s+", clean_name(query).lower()) if t]
        if not terms:
            return []
        found = []
        for name, rows in self.by_name.items():
            haystack = clean_name(name).lower() + " " + " ".join(str(r.get("거래처상품명") or "") for r in rows[:3]).lower()
            if all(t in haystack for t in terms):
                info = self.summarize(rows)
                info["ably_nos"] = sorted({str(r.get("에이블리상품번호") or "").strip() for r in rows} - {""})[:3]
                found.append(info)
        found.sort(key=lambda x: (-x["option_count"], x["base_name"]))
        return found[:limit]

    # ---- 옵션 ----
    def match_option(self, rows: list[dict], parts, goods_option_sno, manual_code: str = "") -> tuple[str, Optional[dict]]:
        if manual_code:
            for row in rows:
                if str(row.get("상품코드") or "").strip() == manual_code:
                    return "manual", row
        if goods_option_sno:
            for row in rows:
                if str(row.get("옵션번호") or "").strip() == str(goods_option_sno):
                    return "id", row
        tokens = option_tokens(parts)
        if not tokens:
            return "", None
        for drop_soft in (False, True):
            want = [t for t in tokens if not (drop_soft and t in _SOFT_TOKENS)]
            hits = [
                row for row in rows
                if [t for t in option_tokens([row.get("색상"), row.get("사이즈")]) if not (drop_soft and t in _SOFT_TOKENS)] == want
            ]
            if len(hits) == 1:
                return "name", hits[0]
        return "", None

    @staticmethod
    def option_info(row: dict) -> dict:
        return {
            "code": str(row.get("상품코드") or "").strip(),
            "option_no": str(row.get("옵션번호") or "").strip(),
            "key": option_key([row.get("색상"), row.get("사이즈")]),
            "label": " ".join(x for x in (str(row.get("색상") or "").strip(), str(row.get("사이즈") or "").strip()) if x),
            "cost": _to_number(row.get("원가")),
            "supplier": str(row.get("거래처") or "").strip(),
            "supplier_product": str(row.get("거래처상품명") or "").strip(),
            "status": " / ".join(x for x in (str(row.get("진열상태") or "").strip(), str(row.get("품절상태") or "").strip()) if x),
        }
