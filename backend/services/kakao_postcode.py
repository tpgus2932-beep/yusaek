"""카카오(다음) 우편번호 검색 결과 조회.

이지어드민의 주소 검색 팝업이 쓰는 postcode.map.kakao.com/search 페이지를 그대로 조회하고,
결과 항목(li.list_post_item)의 data-* 속성에서 우편번호(기초구역번호)와 주소를 읽는다.
"""
from __future__ import annotations

import html
import re

import httpx

SEARCH_URL = "https://postcode.map.kakao.com/search"

# 이지어드민·에이블리가 쓰는 시/도 약칭 (예: 서울특별시 → 서울)
_SIDO_SHORT = [
    ("서울특별시", "서울"), ("부산광역시", "부산"), ("대구광역시", "대구"), ("인천광역시", "인천"),
    ("광주광역시", "광주"), ("대전광역시", "대전"), ("울산광역시", "울산"), ("세종특별자치시", "세종"),
    ("경기도", "경기"), ("강원특별자치도", "강원"), ("강원도", "강원"), ("충청북도", "충북"), ("충청남도", "충남"),
    ("전북특별자치도", "전북"), ("전라북도", "전북"), ("전라남도", "전남"), ("경상북도", "경북"),
    ("경상남도", "경남"), ("제주특별자치도", "제주"),
]

_LI = re.compile(r'<li class="list_post_item[^"]*"(.*?)</li>', re.S)
_ATTR = re.compile(r'data-([\w-]+)="([^"]*)"')
_SPAN = re.compile(r'<span class="txt_address[^"]*"([^>]*)>')


def short_address(address: str) -> str:
    """'서울특별시 강동구 …' → '서울 강동구 …' (이지어드민에 저장되는 형식)."""
    text = (address or "").strip()
    for full, short in _SIDO_SHORT:
        if text.startswith(full):
            return short + text[len(full):]
    return text


def parse_results(page_html: str) -> list[dict]:
    items: list[dict] = []
    for block in _LI.findall(page_html):
        attrs = {k: html.unescape(v) for k, v in _ATTR.findall(block.split(">", 1)[0] + ">")}
        zonecode = attrs.get("zonecode", "").strip()
        if not zonecode:
            continue
        # 한 항목 안에 도로명/지번 주소가 함께 들어 있을 수 있다.
        addresses: list[dict] = []
        for span_attrs in _SPAN.findall(block):
            span = {k: html.unescape(v) for k, v in _ATTR.findall(span_attrs)}
            if span.get("addr"):
                addresses.append(
                    {
                        "type": "road" if span.get("addr_type") == "R" else "jibun",
                        "address": span["addr"],
                        "short": short_address(span["addr"]),
                        "building": span.get("building_name", ""),
                    }
                )
        if not addresses and attrs.get("addr"):
            addresses.append(
                {
                    "type": "road" if attrs.get("addr_type") == "R" else "jibun",
                    "address": attrs["addr"],
                    "short": short_address(attrs["addr"]),
                    "building": attrs.get("building_name", ""),
                }
            )
        seen = set()
        unique = []
        for a in addresses:
            key = (a["type"], a["address"])
            if key not in seen:
                seen.add(key)
                unique.append(a)
        items.append({"zonecode": zonecode, "addresses": unique})
    return items


def search(query: str, page: int = 1) -> dict:
    """주소 검색. {'total': 전체 건수, 'items': [{zonecode, addresses[...]}]}"""
    query = (query or "").strip()
    if not query:
        return {"total": 0, "items": []}
    res = httpx.get(
        SEARCH_URL,
        params={
            "region_name": query, "cq": query, "cpage": str(page),
            "origin": "https://ga80.ezadmin.co.kr", "mode": "transmit", "vt": "popup",
        },
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=20.0,
        follow_redirects=True,
    )
    res.raise_for_status()
    total_match = re.search(r'data-totalcount="(\d+)"', res.text)
    return {"total": int(total_match.group(1)) if total_match else 0, "items": parse_results(res.text)}
