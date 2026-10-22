"""이지어드민 상품수정 팝업(C208)의 폼을 읽어 상품명만 바꿔 다시 저장하기 위한 파서/직렬화 도구.

저장은 상품 폼 전체를 multipart 로 다시 보내는 방식이라, 화면에 보이는 값을 브라우저가 직렬화하는 것과
같은 규칙으로 그대로 되돌려 보내고 name 만 교체한다.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser

# 상품수정 팝업 폼의 옵션 그리드 입력칸 이름(저장 시 옵션 행마다 한 번씩 전송된다).
OPTION_FIELD_NAMES = (
    "options_barcode", "options_location", "options_supply_options", "options_level",
    "options_extra_price", "options_extra_shop_price",
    *[f"option_extra_column{i}" for i in range(1, 11)],
)

_FORM_START = re.compile(r"<form\b[^>]*\bid=['\"]?myform(?=['\"\s>])[^>]*>", re.I)
_INPUT_RE = re.compile(r"<input\b[^>]*>", re.I)
_ATTR_RE = re.compile(r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")


class _FormParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[tuple[str, str, str]] = []  # (kind, name, value) kind: text | file
        self._textarea: list | None = None
        self._select: dict | None = None

    def handle_starttag(self, tag, attrs):
        a = {k: (v if v is not None else "") for k, v in attrs}
        name = a.get("name")
        if tag == "input":
            if not name or "disabled" in a:
                return
            itype = (a.get("type") or "text").lower()
            if itype == "file":
                self.parts.append(("file", name, ""))
            elif itype in ("checkbox", "radio"):
                if "checked" in a:
                    self.parts.append(("text", name, a.get("value", "on")))
            elif itype in ("submit", "button", "image", "reset"):
                return
            else:
                self.parts.append(("text", name, a.get("value", "")))
        elif tag == "textarea":
            if name and "disabled" not in a:
                self._textarea = [name, ""]
        elif tag == "select":
            if name and "disabled" not in a:
                self._select = {"name": name, "multiple": "multiple" in a, "options": []}
        elif tag == "option" and self._select is not None:
            self._select["options"].append([a.get("value"), "selected" in a, ""])

    def handle_data(self, data):
        if self._textarea is not None:
            self._textarea[1] += data
        elif self._select is not None and self._select["options"]:
            self._select["options"][-1][2] += data

    def handle_endtag(self, tag):
        if tag == "textarea" and self._textarea is not None:
            name, value = self._textarea
            self.parts.append(("text", name, value))
            self._textarea = None
        elif tag == "select" and self._select is not None:
            sel = self._select
            self._select = None
            opts = [(v if v is not None else text.strip(), chosen) for v, chosen, text in sel["options"]]
            if sel["multiple"]:
                for value, chosen in opts:
                    if chosen:
                        self.parts.append(("text", sel["name"], value))
            elif opts:
                chosen = [v for v, c in opts if c]
                self.parts.append(("text", sel["name"], chosen[-1] if chosen else opts[0][0]))


def parse_product_form(html: str) -> list[tuple[str, str, str]]:
    """myform 안의 입력칸을 브라우저가 전송하는 순서와 값으로 돌려준다. [(kind, name, value)]"""
    m = _FORM_START.search(html)
    if not m:
        return []
    end = html.find("</form>", m.end())
    parser = _FormParser()
    parser.feed(html[m.end(): end if end != -1 else len(html)])
    parser.close()
    return parser.parts


def get_form_value(parts: list[tuple[str, str, str]], name: str) -> str:
    for kind, n, value in parts:
        if kind == "text" and n == name:
            return value
    return ""


def _attr_values(tag: str) -> dict:
    attrs = {}
    for key, v1, v2, v3 in _ATTR_RE.findall(tag):
        attrs[key.lower()] = v1 or v2 or v3
    return attrs


def parse_option_rows(grid_json: dict) -> list[dict]:
    """get_option_list 응답에서 옵션 행별 입력값을 읽는다. [{"id": "S26468", "options_barcode": "...", ...}]"""
    rows = []
    for row in grid_json.get("rows") or []:
        cell = row.get("cell") or {}
        values = {"id": str(row.get("id") or "")}
        for html_cell in cell.values():
            if not isinstance(html_cell, str) or "<input" not in html_cell:
                continue
            for tag in _INPUT_RE.findall(html_cell):
                attrs = _attr_values(tag)
                name = attrs.get("name")
                if name in OPTION_FIELD_NAMES:
                    values[name] = attrs.get("value", "")
        rows.append(values)
    return rows


def build_modify_fields(
    parts: list[tuple[str, str, str]], option_rows: list[dict], new_name: str
) -> list[tuple[str, str | None]]:
    """저장 요청 필드 목록. 파일칸은 값 None(빈 파일), name 은 new_name 으로 교체한다."""
    fields: list[tuple[str, str | None]] = []
    for kind, name, value in parts:
        if kind == "file":
            fields.append((name, None))
            continue
        if name == "name":
            value = new_name
        elif name == "options":
            # 브라우저가 줄바꿈을 CRLF 로 보내고 빈 줄은 없다.
            value = "\r\n".join(line for line in re.split(r"\r?\n", value) if line.strip())
        fields.append((name, value))
    for row in option_rows:
        for name in OPTION_FIELD_NAMES:
            fields.append((name, row.get(name, "")))
    return fields
