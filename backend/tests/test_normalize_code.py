import pytest

from barcode_core import normalize_code


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("YUSAS12345", "S12345"),
        ("S12345", "S12345"),
        ("s12345", "S12345"),
        ("yusas12345", "S12345"),
        (" 12 YUSAS00123 ", "S00123"),
        ("YUSAS1234", ""),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_code_returns_s_form(raw, expected):
    assert normalize_code(raw) == expected
