import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.delivery_anomaly_logic import (
    evaluate_anomaly,
    is_invoice_missing,
    latest_scan_date,
    parse_ably_sent_date,
    parse_llogis_scan_date,
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


def test_is_invoice_missing_false_when_only_movement_present():
    # 실제 사례: invInfoList는 없지만 mvmList에 '예약접수' 이력이 있는 경우
    # (접수는 됐으나 아직 invInfoList가 채워지지 않은 단계) — 찾을 수 없는 게 아니다
    llogis_raw = {"invInfoList": None, "mvmList": [{"paclStatNm": "예약접수", "rgstYmd": "20260713105514"}]}
    assert is_invoice_missing(llogis_raw) is False


def test_latest_scan_date_uses_last_movement():
    llogis_raw = {"mvmList": [{"rgstYmd": "20260710"}, {"rgstYmd": "20260715"}]}
    assert latest_scan_date(llogis_raw) == date(2026, 7, 15)


def test_latest_scan_date_none_when_no_movement():
    assert latest_scan_date({"mvmList": []}) is None


def test_evaluate_anomaly_not_yet_two_days_old():
    sent = date(2026, 7, 19)
    today = date(2026, 7, 20)
    assert evaluate_anomaly(sent, today, {"invInfoList": []}) is None


def test_evaluate_anomaly_sent_exactly_two_days_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [], "mvmList": []}
    assert evaluate_anomaly(sent, today, llogis_raw) == "llogis에서 송장을 찾을 수 없음"


def test_evaluate_anomaly_invoice_missing_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음"


def test_evaluate_anomaly_old_stuck_invoice_still_flagged():
    # 발송 5일 지난 것도 (2일 이상 누적 조건) 계속 잡혀야 함
    sent = date(2026, 7, 15)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": [], "mvmList": []})
    assert reason == "llogis에서 송장을 찾을 수 없음"


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


def test_evaluate_anomaly_no_movement_history_flagged():
    sent = date(2026, 7, 18)
    today = date(2026, 7, 20)
    llogis_raw = {"invInfoList": [{"a": 1}], "mvmList": []}
    reason = evaluate_anomaly(sent, today, llogis_raw)
    assert reason == "최종스캔 3일 이상 경과"


def test_evaluate_anomaly_reservation_received_without_inv_info_flagged_via_scan_date():
    # 실제 사례 재현: invInfoList는 null이지만 mvmList에 '예약접수'가 있고 그 날짜가 오래됨.
    # invInfoList만 보고 '송장을 찾을 수 없음'으로 오판하면 안 되고, 최종스캔일 기준으로 판단해야 한다.
    sent = date(2026, 7, 12)
    today = date(2026, 7, 20)
    llogis_raw = {
        "invInfoList": None,
        "mvmList": [{"paclStatNm": "예약접수", "rgstYmd": "20260713105514"}],
    }
    reason = evaluate_anomaly(sent, today, llogis_raw)
    assert reason == "최종스캔 3일 이상 경과"


def test_evaluate_anomaly_truly_missing_when_both_empty():
    sent = date(2026, 7, 15)
    today = date(2026, 7, 20)
    reason = evaluate_anomaly(sent, today, {"invInfoList": None, "mvmList": None})
    assert reason == "llogis에서 송장을 찾을 수 없음"
