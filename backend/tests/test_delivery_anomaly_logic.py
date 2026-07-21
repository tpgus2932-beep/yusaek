import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.delivery_anomaly_logic import (
    LOST_PACKAGE_MESSAGE,
    build_confirm_receipt_message,
    evaluate_anomaly,
    is_invoice_missing,
    latest_movement,
    latest_reply_after,
    latest_scan_date,
    parse_ably_sent_date,
    parse_ezdesk_time,
    parse_llogis_scan_date,
    strip_bracket_tags,
)


def test_parse_ably_sent_date_iso_with_timezone():
    assert parse_ably_sent_date("2026-07-18T10:23:45+09:00") == date(2026, 7, 18)


def test_parse_ably_sent_date_space_separated():
    assert parse_ably_sent_date("2026-07-18 10:23:45") == date(2026, 7, 18)


def test_parse_ably_sent_date_none_or_empty():
    assert parse_ably_sent_date(None) is None
    assert parse_ably_sent_date("") is None


def test_parse_ably_sent_date_garbage_returns_none():
    assert parse_ably_sent_date("not-a-date") is None


def test_parse_llogis_scan_date_valid():
    assert parse_llogis_scan_date("20260718") == date(2026, 7, 18)


def test_parse_llogis_scan_date_invalid_length():
    assert parse_llogis_scan_date("2026718") is None
    assert parse_llogis_scan_date(None) is None


def test_parse_llogis_scan_date_with_time_suffix():
    # 실제 llogis rgstYmd는 'YYYYMMDDHHmmss'(14자리)로 오는 경우가 있다
    assert parse_llogis_scan_date("20260713105514") == date(2026, 7, 13)


def test_is_invoice_missing_true_when_no_inv_info():
    assert is_invoice_missing({"invInfoList": [], "mvmList": []}) is True
    assert is_invoice_missing({}) is True


def test_is_invoice_missing_false_when_inv_info_present():
    assert is_invoice_missing({"invInfoList": [{"a": 1}]}) is False


def test_is_invoice_missing_true_when_only_reservation_received():
    # 실제 사례: invInfoList는 없고 mvmList에 '예약접수'만 있는 경우 (집화 전 단계) —
    # 아직 택배사가 실제로 수거하지 않아 추적 정보가 없는 것이므로 찾을 수 없음으로 본다
    llogis_raw = {"invInfoList": None, "mvmList": [{"paclStatNm": "예약접수", "rgstYmd": "20260713105514"}]}
    assert is_invoice_missing(llogis_raw) is True


def test_is_invoice_missing_false_when_real_movement_exists_without_inv_info():
    # invInfoList는 없더라도 mvmList에 예약접수 이후 실제 이동 스캔이 있으면
    # (집화되어 실제로 추적되고 있는 것) 찾을 수 없음으로 보면 안 된다
    llogis_raw = {
        "invInfoList": None,
        "mvmList": [
            {"paclStatNm": "예약접수", "rgstYmd": "20260710"},
            {"paclStatNm": "간선상차", "rgstYmd": "20260719"},
        ],
    }
    assert is_invoice_missing(llogis_raw) is False


def test_latest_scan_date_uses_last_movement():
    llogis_raw = {"mvmList": [{"rgstYmd": "20260710"}, {"rgstYmd": "20260715"}]}
    assert latest_scan_date(llogis_raw) == date(2026, 7, 15)


def test_latest_scan_date_none_when_no_movement():
    assert latest_scan_date({"mvmList": []}) is None


def test_latest_scan_date_handles_out_of_order_mvm_list():
    # 실제 사례 재현: llogis mvmList가 시간순으로 정렬되어 있지 않음
    # (같은 허브의 도착/처리 이벤트가 뒤섞여 옴). 배열 끝이 아니어도 진짜 최신 스캔을 찾아야 한다.
    llogis_raw = {
        "mvmList": [
            {"rgstYmd": "20260716094108", "paclStatNm": "예약접수"},
            {"rgstYmd": "20260718110303", "paclStatNm": "적입"},
            {"rgstYmd": "20260717201927", "paclStatNm": "구간도착"},  # 배열상 앞 항목보다 시간은 이전
            {"rgstYmd": "20260720083430", "paclStatNm": "배달전"},  # 실제 최신이지만 배열 끝은 아님
            {"rgstYmd": "20260718030317", "paclStatNm": "셔틀발송"},
        ],
    }
    assert latest_scan_date(llogis_raw) == date(2026, 7, 20)
    assert latest_movement(llogis_raw)["paclStatNm"] == "배달전"


def test_evaluate_anomaly_not_yet_two_days_old():
    sent = date(2026, 7, 19)
    today = date(2026, 7, 20)
    assert evaluate_anomaly(sent, today, {"invInfoList": []}) is None


def test_evaluate_anomaly_sent_exactly_two_days_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [], "mvmList": []}
    assert evaluate_anomaly(sent, today, llogis_raw) == "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"


def test_evaluate_anomaly_invoice_missing_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"


def test_evaluate_anomaly_old_stuck_invoice_still_flagged():
    # 발송 5일 지난 것도 (2일 이상 누적 조건) 계속 잡혀야 함
    sent = date(2026, 7, 15)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"


def test_evaluate_anomaly_not_flagged_when_recent_scan_buried_out_of_order():
    # 실제 사례 재현: 최신 스캔(7/20)이 배열 끝이 아닌 위치에 있어도
    # 최종스캔일이 2일 이내(오늘 7/21 기준)이므로 이상현상으로 잡히면 안 된다
    sent = date(2026, 7, 16)
    today = date(2026, 7, 21)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [
            {"rgstYmd": "20260716094108", "paclStatNm": "예약접수"},
            {"rgstYmd": "20260718110303", "paclStatNm": "적입"},
            {"rgstYmd": "20260717201927", "paclStatNm": "구간도착"},
            {"rgstYmd": "20260720083430", "paclStatNm": "배달전"},
            {"rgstYmd": "20260718030317", "paclStatNm": "셔틀발송"},
        ],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_scan_exactly_three_days_flagged():
    sent = date(2026, 7, 17)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260717", "paclStatNm": "간선상차"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) == "최종스캔 3일 이상 경과"


def test_evaluate_anomaly_scan_two_days_not_flagged():
    sent = date(2026, 7, 17)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260718", "paclStatNm": "간선상차"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_recent_scan_not_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": [{"a": 1}],
        "mvmList": [{"rgstYmd": "20260719", "paclStatNm": "배송완료"}],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_not_flagged_when_recent_movement_despite_missing_inv_info():
    # invInfoList가 비어 있어도 mvmList에 최근(2일 이내) 실제 이동 스캔이 있으면
    # 정상 추적 중인 것이므로 이상현상으로 잡히면 안 된다
    sent = date(2026, 7, 17)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": None,
        "mvmList": [
            {"paclStatNm": "예약접수", "rgstYmd": "20260717"},
            {"paclStatNm": "간선상차", "rgstYmd": "20260719"},
        ],
    }
    assert evaluate_anomaly(sent, today, llogis_raw) is None


def test_evaluate_anomaly_no_movement_history_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [{"a": 1}], "mvmList": []}
    reason = evaluate_anomaly(sent, today, llogis_raw)
    assert reason == "최종스캔 3일 이상 경과"


def test_evaluate_anomaly_reservation_received_without_pickup_flagged_as_missing():
    # 실제 사례 재현: invInfoList는 null이고 mvmList에 '예약접수'만 있음 (집화 전) —
    # 아직 택배사가 수거하지 않은 상태이므로 '송장을 찾을 수 없음'으로 분류한다
    sent = date(2026, 7, 12)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": None,
        "mvmList": [{"paclStatNm": "예약접수", "rgstYmd": "20260713105514"}],
    }
    reason = evaluate_anomaly(sent, today, llogis_raw)
    assert reason == "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"


def test_evaluate_anomaly_truly_missing_when_both_empty():
    sent = date(2026, 7, 15)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": None, "mvmList": None})
    assert reason == "llogis에서 송장을 찾을 수 없음 (다른 택배사이거나 미등록 송장)"


def test_strip_bracket_tags_removes_bracket_and_trims():
    name = "[넥라인선택!/10컬러/슬림핏보장🖤] 디솔 슬림 셔링 7부 티셔츠"
    assert strip_bracket_tags(name) == "디솔 슬림 셔링 7부 티셔츠"


def test_strip_bracket_tags_multiple_brackets():
    assert strip_bracket_tags("[A][B] 상품명 [C]") == "상품명"


def test_strip_bracket_tags_no_brackets_unchanged():
    assert strip_bracket_tags("그냥 상품명") == "그냥 상품명"


def test_strip_bracket_tags_none_or_empty():
    assert strip_bracket_tags(None) == ""
    assert strip_bracket_tags("") == ""


def test_build_confirm_receipt_message_includes_stripped_product_name():
    msg = build_confirm_receipt_message("[넥라인선택!/10컬러/슬림핏보장🖤] 디솔 슬림 셔링 7부 티셔츠")
    assert "주문해주신 디솔 슬림 셔링 7부 티셔츠의 배송 조회가" in msg
    assert "[" not in msg
    assert msg.startswith("안녕하세요, 에이블리 유색입니다.")
    assert msg.endswith("감사합니다. 좋은 하루 보내세요")


def test_build_confirm_receipt_message_falls_back_when_no_product_name():
    msg = build_confirm_receipt_message(None)
    assert "주문해주신 주문하신 상품의 배송 조회가" in msg


def test_parse_ezdesk_time_datetime_format():
    assert parse_ezdesk_time("2026-07-20 20:19:16") == datetime(2026, 7, 20, 20, 19, 16)


def test_parse_ezdesk_time_iso_with_t():
    assert parse_ezdesk_time("2026-07-20T20:19:16") == datetime(2026, 7, 20, 20, 19, 16)


def test_parse_ezdesk_time_date_only():
    assert parse_ezdesk_time("2026-07-20") == datetime(2026, 7, 20, 0, 0, 0)


def test_parse_ezdesk_time_none_or_empty():
    assert parse_ezdesk_time(None) is None
    assert parse_ezdesk_time("") is None


def test_latest_reply_after_finds_reply_after_since():
    since = datetime(2026, 7, 20, 20, 19, 16)
    messages = [
        {"direction": "sent", "content": "확인 부탁드립니다", "input_time": "2026-07-20 20:19:16"},
        {"direction": "received", "content": "네 받았어요", "input_time": "2026-07-20 21:00:00"},
    ]
    reply = latest_reply_after(messages, since)
    assert reply["content"] == "네 받았어요"


def test_latest_reply_after_ignores_replies_before_since():
    since = datetime(2026, 7, 20, 20, 19, 16)
    messages = [
        {"direction": "received", "content": "예전 문의입니다", "input_time": "2026-07-18 10:00:00"},
    ]
    assert latest_reply_after(messages, since) is None


def test_latest_reply_after_ignores_sent_messages():
    since = datetime(2026, 7, 20, 20, 19, 16)
    messages = [
        {"direction": "sent", "content": "확인 부탁드립니다", "input_time": "2026-07-20 22:00:00"},
    ]
    assert latest_reply_after(messages, since) is None


def test_latest_reply_after_picks_latest_when_multiple_replies():
    since = datetime(2026, 7, 20, 20, 19, 16)
    messages = [
        {"direction": "received", "content": "첫 답장", "input_time": "2026-07-20 21:00:00"},
        {"direction": "received", "content": "나중 답장", "input_time": "2026-07-21 09:00:00"},
    ]
    reply = latest_reply_after(messages, since)
    assert reply["content"] == "나중 답장"


def test_latest_reply_after_returns_none_when_no_messages():
    assert latest_reply_after([], datetime(2026, 7, 20, 20, 19, 16)) is None


def test_lost_package_message_content():
    assert LOST_PACKAGE_MESSAGE.startswith("안녕하세요 고객님, 유색입니다 :)")
    assert "택배사 분실 건으로 확인되었습니다" in LOST_PACKAGE_MESSAGE
    assert "취소 접수 후 환불" in LOST_PACKAGE_MESSAGE
    assert LOST_PACKAGE_MESSAGE.endswith("정말 죄송합니다.")
