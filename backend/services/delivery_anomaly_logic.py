from __future__ import annotations

import re
from datetime import date


def parse_ably_sent_date(raw: str | None) -> date | None:
    """에이블리 발송일('2026-07-18T10:23:45+09:00' 또는 '2026-07-18 10:23:45' 등)을 date로 변환."""
    if not raw:
        return None
    text = str(raw).strip()
    if len(text) < 10:
        return None
    try:
        return date(int(text[0:4]), int(text[5:7]), int(text[8:10]))
    except (ValueError, IndexError):
        return None


def parse_llogis_scan_date(raw: str | None) -> date | None:
    """llogis 최종스캔일('20260718' 또는 시분초 포함 '20260718105514' 등)을 date로 변환."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) < 8:
        return None
    try:
        return date(int(digits[0:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        return None


def is_invoice_missing(llogis_raw: dict) -> bool:
    """llogis에 송장 자체가 전혀 없는 경우만 True.

    invInfoList가 비어 있어도 mvmList(이동이력)가 있으면 실제로는 접수·등록된
    송장이다 (예: 예약접수 후 아직 invInfoList가 채워지지 않은 단계) — 이 경우는
    '찾을 수 없음'이 아니라 최종스캔일 기준으로 판단해야 한다.
    """
    has_inv_info = bool(llogis_raw.get("invInfoList") or [])
    has_movement = bool(llogis_raw.get("mvmList") or [])
    return not has_inv_info and not has_movement


def latest_scan_date(llogis_raw: dict) -> date | None:
    mvm_list = llogis_raw.get("mvmList") or []
    if not mvm_list:
        return None
    return parse_llogis_scan_date(mvm_list[-1].get("rgstYmd"))


def evaluate_anomaly(sent_date: date | None, today: date, llogis_raw: dict) -> str | None:
    """이상현상이면 사유 문자열, 아니면 None.

    조건: 발송일이 오늘로부터 2일 이상 지났으면서
      - llogis에서 송장을 찾을 수 없거나 (invInfoList 없음)
      - 최종스캔일이 없거나 오늘로부터 3일 이상 지난 경우
    """
    if sent_date is None:
        return None
    if (today - sent_date).days < 2:
        return None
    if is_invoice_missing(llogis_raw):
        return "llogis에서 송장을 찾을 수 없음"
    scan_date = latest_scan_date(llogis_raw)
    if scan_date is None or (today - scan_date).days >= 3:
        return "최종스캔 3일 이상 경과"
    return None
