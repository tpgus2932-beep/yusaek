import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.returns_utils import ReturnState, _return_queue_payload


def test_return_queue_payload_dedupes_unmatched_by_scan():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111", "match": "", "item_text": "first"}
    item_b = {"id": 2, "scan": "111", "match": "", "item_text": "duplicate"}
    item_c = {"id": 3, "scan": "222", "match": "", "item_text": "other"}
    state.queue_unmatched = [item_a, item_b, item_c]

    payload = _return_queue_payload(state)

    assert payload["unmatched"] == [item_a, item_c]
    assert state.queue_unmatched == [item_a, item_c]


def test_return_queue_payload_keeps_unique_unmatched_untouched():
    state = ReturnState(cost_base_path=Path("nonexistent.xlsx"))
    item_a = {"id": 1, "scan": "111", "match": ""}
    item_b = {"id": 2, "scan": "222", "match": ""}
    state.queue_unmatched = [item_a, item_b]

    payload = _return_queue_payload(state)

    assert payload["unmatched"] == [item_a, item_b]
