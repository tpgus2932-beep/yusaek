from __future__ import annotations

import re
from datetime import date, datetime


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
    """송장 자체를 추적할 수 없는 경우인지 판단.

    invInfoList가 있으면 추적 가능한 송장이다.
    invInfoList가 없어도 mvmList에 '예약접수' 이외의 실제 이동 스캔이 있으면
    (택배사가 집화해서 실제로 스캔이 찍히고 있는 것) 추적 가능한 것으로 본다 —
    이 경우는 최종스캔일 기준(evaluate_anomaly의 3일 경과 조건)으로 판단해야 한다.
    invInfoList도 없고 mvmList도 비어있거나 '예약접수'만 있으면(집화 전 단계)
    실질적인 추적 정보가 없는 것이므로 찾을 수 없는 것으로 본다.
    """
    if llogis_raw.get("invInfoList"):
        return False
    mvm_list = llogis_raw.get("mvmList") or []
    real_movement = [m for m in mvm_list if (m.get("paclStatNm") or "") != "예약접수"]
    return not real_movement


def _sortable_scan_key(raw: str | None) -> str | None:
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) < 8:
        return None
    return (digits + "000000")[:14]


def latest_movement(llogis_raw: dict) -> dict | None:
    """mvmList 중 rgstYmd 기준으로 가장 최근인 이동 이력 항목을 반환.

    llogis mvmList는 API 응답 순서가 시간순으로 정렬되어 있지 않은 경우가 있다
    (같은 허브의 도착/처리 이벤트가 뒤섞여 오는 경우 관찰됨). 배열의 마지막 항목이
    항상 최신이라고 가정하면 실제로는 더 최근 스캔이 있어도 놓칠 수 있으므로,
    각 항목의 rgstYmd를 직접 비교해서 진짜 최신 항목을 찾는다.
    """
    mvm_list = llogis_raw.get("mvmList") or []
    best = None
    best_key = None
    for m in mvm_list:
        key = _sortable_scan_key(m.get("rgstYmd"))
        if key is None:
            continue
        if best_key is None or key > best_key:
            best = m
            best_key = key
    return best


def latest_scan_date(llogis_raw: dict) -> date | None:
    m = latest_movement(llogis_raw)
    if m is None:
        return None
    return parse_llogis_scan_date(m.get("rgstYmd"))


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
        return "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"
    scan_date = latest_scan_date(llogis_raw)
    if scan_date is None or (today - scan_date).days >= 3:
        return "최종스캔 3일 이상 경과"
    return None


def strip_bracket_tags(product_name: str | None) -> str:
    """상품명에서 '[...]' 태그(옵션/홍보 문구 등)를 제거하고 공백을 정리."""
    text = re.sub(r"\[[^\]]*\]", "", str(product_name or ""))
    return re.sub(r"\s+", " ", text).strip()


def build_confirm_receipt_message(product_name: str | None) -> str:
    """수령여부확인 문자 본문. [상품] 자리에 대괄호 태그를 제거한 상품명이 들어간다."""
    product = strip_bracket_tags(product_name) or "주문하신 상품"
    return (
        "안녕하세요, 에이블리 유색입니다.\n\n"
        f"주문해주신 {product}의 배송 조회가 중간 단계에서 멈춰 있는 것으로 확인되어 연락드렸습니다.\n\n"
        "혹시 상품을 이미 수령하셨는지 확인 부탁드립니다. 번거로우시겠지만 수령 여부를 간단히 답장으로 남겨주시면 감사하겠습니다.\n\n"
        "만약 아직 받지 못하셨다면 바로 확인 후 안내 도와드리겠습니다.\n\n"
        "감사합니다. 좋은 하루 보내세요"
    )


LOST_PACKAGE_MESSAGE = (
    "안녕하세요 고객님, 유색입니다 :)\n\n"
    "먼저 배송 과정에서 큰 불편을 드려 정말 죄송합니다.\n\n"
    "해당 건은 택배사 측 확인 결과, 배송 중 택배사 분실 건으로 확인되었습니다.\n\n"
    "고객님께서 기다려주셨을 텐데 정상적으로 상품을 받아보시지 못하게 되어 진심으로 죄송합니다. "
    "저희도 배송 흐름 확인 후 택배사 측에 확인을 진행했으나, 분실로 확인되어 안내드리게 된 점 정말 죄송합니다.\n\n"
    "해당 건은 고객님께서 원하시는 방향으로 처리 도와드리겠습니다.\n\n"
    "취소 접수 후 환불로 진행 도와드릴지, 또는 상품 재출고로 다시 받아보실 수 있도록 도와드릴지 "
    "말씀해주시면 확인 후 최대한 빠르게 처리 도와드리겠습니다.\n\n"
    "다시 한 번 배송 문제로 불편을 드려 정말 죄송합니다."
)


def parse_ezdesk_time(raw: str | None) -> datetime | None:
    """EZDesk 대화 시각('2026-07-20 20:19:16' 형태의 MySQL DATETIME 문자열 등)을 datetime으로 변환."""
    text = str(raw or "").strip()
    if not text:
        return None
    text = text.replace("T", " ")[:19]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def latest_reply_after(normalized_messages: list[dict], since: datetime) -> dict | None:
    """since 이후에 수신(receive)된 메시지 중 가장 최근 것을 반환.

    normalized_messages는 sdk.ezadmin.normalize_sms_row로 정규화된
    {input_time, direction, content, ...} 형태의 리스트를 받는다.
    """
    best = None
    best_dt = None
    for msg in normalized_messages:
        if msg.get("direction") != "received":
            continue
        if not str(msg.get("content") or "").strip():
            continue
        dt = parse_ezdesk_time(msg.get("input_time"))
        if dt is None or dt <= since:
            continue
        if best_dt is None or dt > best_dt:
            best = msg
            best_dt = dt
    if best is None:
        return None
    return {"content": str(best["content"]).strip(), "input_time": best_dt.isoformat()}
