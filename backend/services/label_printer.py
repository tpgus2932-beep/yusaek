r"""상품 바코드 라벨(39.9x30mm)을 이 PC의 윈도우 프린터로 대화상자 없이 바로 출력한다.

라벨 레이아웃은 프론트 printProductLabels(상품명 / [옵션] / CODE128 바코드)와 동일하다.
프린터는 요청에서 지정한 이름(공유 프린터는 \\PC이름\프린터이름), 없으면 LABEL_PRINTER_NAME 환경변수, 그것도 없으면 윈도우 기본 프린터를 쓴다.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

RENDER_DPI = 600  # 고해상도로 그린 뒤 프린터 해상도로 축소
# 바코드 인쇄.pdf 실측값 (pt)
PAGE_W_PT, PAGE_H_PT = 113.04, 84.96
PAD_PT = 4.25
TITLE_PT, TITLE_LINE_PT = 9.0, 11.25
OPTION_PT, OPTION_LINE_PT, OPTION_GAP_PT = 8.0, 10.8, 2.3
BARCODE_GAP_PT = 4.25
BAR_UNIT, BAR_VIEW_H, BAR_SVG_H_PT = 2.3, 40, 22.68  # JsBarcode width/height, 8mm
_FONT_NOTO_NAME = "NotoSansKR-VF.ttf"


def _find_noto() -> str:
    """PyInstaller로 묶은 경우 동봉된 폰트, 그 외 모듈 옆 폴더, 마지막으로 윈도우 폰트 폴더."""
    here = os.path.dirname(os.path.abspath(__file__))
    for base in (getattr(sys, "_MEIPASS", ""), here, os.path.join(here, ".."), "C:/Windows/Fonts"):
        path = os.path.join(base, _FONT_NOTO_NAME) if base else ""
        if path and os.path.exists(path):
            return path
    return _FONT_NOTO_NAME


_FONT_NOTO = _find_noto()
_FONT_REG = "C:/Windows/Fonts/malgun.ttf"
_FONT_BOLD = "C:/Windows/Fonts/malgunbd.ttf"

# CODE128 패턴 (0~105: 6개 막대/공백 너비, 106: STOP 7개)
_PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
    "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
    "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
    "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
    "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
    "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
    "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
    "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
    "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
    "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
    "211214", "211232", "2331112",
]


def _code128_widths(text: str) -> list[int]:
    """JsBarcode CODE128(auto)와 같은 방식: 숫자가 길게 이어지면 CODE C, 아니면 CODE B."""
    codes: list[int] = []
    mode = None
    i = 0
    while i < len(text):
        run = 0
        while i + run < len(text) and text[i + run].isdigit():
            run += 1
        want_c = run >= (4 if i == 0 else 6)
        if want_c:
            if mode != "C":
                codes.append(105 if mode is None else 99)
                mode = "C"
            n = run - (run % 2)
            for j in range(i, i + n, 2):
                codes.append(int(text[j:j + 2]))
            i += n
            continue
        if mode != "B":
            codes.append(104 if mode is None else 100)
            mode = "B"
        o = ord(text[i]) - 32
        if not 0 <= o <= 94:
            raise ValueError(f"CODE128로 인코딩할 수 없는 문자: {text[i]!r}")
        codes.append(o)
        i += 1
    checksum = (codes[0] + sum(k * c for k, c in enumerate(codes[1:], start=1))) % 103
    codes += [checksum, 106]
    return [int(d) for c in codes for d in _PATTERNS[c]]


def _font(weight: int, size: float):
    """PDF와 같은 Noto Sans KR(가변 폰트). 없으면 맑은 고딕으로 대체."""
    try:
        f = ImageFont.truetype(_FONT_NOTO, size)
        f.set_variation_by_axes([weight])
        return f
    except (OSError, AttributeError):
        return ImageFont.truetype(_FONT_BOLD if weight >= 600 else _FONT_REG, size)


def _wrap(draw, text: str, font, max_w: float) -> list[str]:
    """브라우저(Chrome)처럼 줄바꿈: 한글/CJK는 글자 단위, 그 외는 공백 단위로 끊는다."""
    tokens: list[str] = []
    buf = ""
    for ch in " ".join(text.split()):
        if ch == " ":
            if buf:
                tokens.append(buf)
                buf = ""
            tokens.append(" ")
        elif ord(ch) >= 0x1100:
            if buf:
                tokens.append(buf)
                buf = ""
            tokens.append(ch)
        else:
            buf += ch
    if buf:
        tokens.append(buf)

    lines, cur = [], ""
    for tok in tokens:
        if tok == " " and not cur:
            continue
        if draw.textlength((cur + tok).rstrip(), font=font) <= max_w or not cur:
            cur += tok
            continue
        lines.append(cur.rstrip())
        cur = tok.lstrip()
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def render_label(title: str, option: str, code: str) -> Image.Image:
    """바코드 인쇄.pdf(39.88x29.97mm) 레이아웃을 pt 좌표 그대로 재현한다."""
    s = RENDER_DPI / 72  # pt -> px
    w, h = round(PAGE_W_PT * s), round(PAGE_H_PT * s)
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    inner_w = PAGE_W_PT - 2 * PAD_PT

    f_title = _font(700, TITLE_PT * s)
    f_opt = _font(400, OPTION_PT * s)
    title_lines = _wrap(d, title or "", f_title, inner_w * s)

    widths = _code128_widths(code)
    modules = sum(widths)
    scale = min(inner_w / (modules * BAR_UNIT), BAR_SVG_H_PT / BAR_VIEW_H)
    bar_h = BAR_VIEW_H * scale
    bar_w = modules * BAR_UNIT * scale

    opt_block = (OPTION_GAP_PT + OPTION_LINE_PT) if option else 0
    block_h = len(title_lines) * TITLE_LINE_PT + opt_block + BARCODE_GAP_PT + bar_h
    y = (PAGE_H_PT - block_h) / 2  # 세로 가운데 정렬 (flex center)

    for line in title_lines:
        d.text((w / 2, y * s), line, font=f_title, fill=0, anchor="ma")
        y += TITLE_LINE_PT
    if option:
        y += OPTION_GAP_PT
        d.text((w / 2, y * s), option, font=f_opt, fill=0, anchor="ma")
        y += OPTION_LINE_PT
    y += BARCODE_GAP_PT

    x = (PAGE_W_PT - bar_w) / 2
    unit = BAR_UNIT * scale
    for i, bw in enumerate(widths):
        if i % 2 == 0:
            d.rectangle([round(x * s), round(y * s), round((x + bw * unit) * s) - 1, round((y + bar_h) * s) - 1], fill=0)
        x += bw * unit
    return img


def list_printers() -> dict:
    """이 서버 PC에 설치/연결된 프린터 이름 목록과 기본 프린터."""
    import win32print

    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    names = [p["pPrinterName"] for p in win32print.EnumPrinters(flags, None, 4)]
    try:
        default = win32print.GetDefaultPrinter()
    except Exception:
        default = ""
    return {"printers": names, "default": default}


def print_labels(labels: list[dict], printer: str = "") -> int:
    """labels: [{title, option, code}]. 라벨 1장 = 1페이지로 출력하고 출력한 장수를 돌려준다."""
    import win32con
    import win32print
    import win32ui
    from PIL import ImageWin

    valid = [l for l in labels if l.get("code")]
    if not valid:
        return 0
    printer = (printer or "").strip() or os.getenv("LABEL_PRINTER_NAME") or win32print.GetDefaultPrinter()
    dc = win32ui.CreateDC()
    dc.CreatePrinterDC(printer)
    try:
        pw = dc.GetDeviceCaps(win32con.HORZRES)
        ph = dc.GetDeviceCaps(win32con.VERTRES)
        dc.StartDoc("상품 바코드 라벨")
        for l in valid:
            img = render_label(str(l.get("title") or ""), str(l.get("option") or ""), str(l["code"]))
            img = img.resize((pw, ph), Image.LANCZOS).convert("RGB")
            dc.StartPage()
            ImageWin.Dib(img).draw(dc.GetHandleOutput(), (0, 0, pw, ph))
            dc.EndPage()
        dc.EndDoc()
    finally:
        dc.DeleteDC()
    return len(valid)
