import io
import re
import urllib.parse
from pathlib import Path

import pandas as pd
import xlwt


HEADER_LIST = [
    "상품명","공급처코드 / 공급처명","공급처 상품명","공급처 옵션","원산지","택배비","중량",
    "원가","공급가","판매가","시중가","옵션1","옵션2","옵션3","옵션관리","바코드",
    "대표 이미지","설명 이미지1","설명 이미지2","설명 이미지3","설명 이미지4","설명 이미지5",
    "비고 이미지","상품설명","상품설명2","재고경고수량","재고위험수량","합포불가",
    "동일상품 합포가능 수량","로케이션","메모","제조사","사은품","담당MD","관리자(정)",
    "관리자(부)","무료배송","카테고리","배송타입","매장간이동","판매시작일","입고대기",
    "판매처코드 / 판매처명","상품태그","상품추가항목1","상품추가항목2","상품추가항목3",
    "상품추가항목4","상품추가항목5","상품추가항목6","상품추가항목7","상품추가항목8",
    "상품추가항목9","상품추가항목10","소진시 품절","입고시 품절해제","소진시 일시품절",
    "입고시 일시품절해제","옵션추가항목1","옵션추가항목2","옵션추가항목3","옵션추가항목4",
    "옵션추가항목5","옵션추가금액(원가)","옵션추가금액(판매가)","매칭시 자동취소",
    "유통기한 경고 설정","판매상태","원가메모","재고단위1","재고단위2","재고단위3","재고단위4","재고단위5"
]

_FRONT_BRACKETS = re.compile(r"^(\s*\[[^\]]*\]\s*)+")
_BACK_BRACKETS = re.compile(r"(\s*\[[^\]]*\]\s*)+$")


def _content_disposition(filename: str) -> str:
    safe_name = (filename or "download").replace('"', "")
    ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in safe_name)
    ascii_name = re.sub(r"_+", "_", ascii_name).strip("_")
    if not ascii_name:
        ascii_name = "download"
    quoted = urllib.parse.quote(safe_name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def _strip_edge_brackets(text):
    if pd.isna(text):
        return text
    s = str(text)
    s = re.sub(_FRONT_BRACKETS, "", s)
    s = re.sub(_BACK_BRACKETS, "", s)
    return s.strip()


def _split_b_to_c_and_h(value):
    if pd.isna(value):
        return pd.NA, pd.NA
    s = str(value).strip()
    if not s:
        return pd.NA, pd.NA
    parts = s.split()
    if len(parts) <= 2:
        return " ".join(parts), pd.NA
    if len(parts) == 3:
        c_part = " ".join(parts[:2])
        try:
            h_part = int(parts[2])
        except ValueError:
            h_part = pd.NA
        return c_part, h_part
    return " ".join(parts), pd.NA


def _split_l_values(value):
    if pd.isna(value):
        return pd.NA, pd.NA, pd.NA
    tokens = [t.strip() for t in str(value).split(",") if t.strip()]
    tokens = [f":{t}" for t in tokens[:3]]
    while len(tokens) < 3:
        tokens.append(pd.NA)
    return tokens[0], tokens[1], tokens[2]


def _col_to_num(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def _pos0(col: str) -> int:
    return _col_to_num(col) - 1


def _save_as_xls_bytes(df: pd.DataFrame) -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("Sheet1")
    for j, col in enumerate(df.columns):
        sheet.write(0, j, col)
    for i, row in df.iterrows():
        for j, val in enumerate(row):
            if pd.isna(val):
                sheet.write(i + 1, j, "")
            else:
                sheet.write(i + 1, j, val)
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def _process_easyadmin_product_upload(path: Path) -> bytes:
    ext = path.suffix.lower()
    if ext == ".xlsx":
        df = pd.read_excel(path, engine="openpyxl")
    elif ext == ".xls":
        df = pd.read_excel(path)
    elif ext == ".csv":
        try:
            df = pd.read_csv(path, encoding="utf-8")
        except UnicodeDecodeError:
            df = pd.read_csv(path, encoding="cp949")
    else:
        raise ValueError("지원 형식: xlsx, xls, csv")

    if df.shape[1] < 12:
        raise ValueError("원본 파일에 최소 12열(C, H, L 포함)이 필요합니다.")

    series_b = df.iloc[:, 1]
    series_c = df.iloc[:, 2]
    series_h = df.iloc[:, 7]
    series_l = df.iloc[:, 11]

    col_a = series_c.apply(_strip_edge_brackets)
    col_b = pd.Series(["유색"] * len(df), index=df.index)
    ch_df = series_b.apply(lambda v: pd.Series(_split_b_to_c_and_h(v)))
    lmn_df = series_l.apply(lambda v: pd.Series(_split_l_values(v)))

    out = pd.DataFrame("", index=df.index, columns=HEADER_LIST).astype(object)
    out.iloc[:, _pos0("A")] = col_a
    out.iloc[:, _pos0("B")] = col_b
    out.iloc[:, _pos0("C")] = ch_df.iloc[:, 0]
    out.iloc[:, _pos0("H")] = ch_df.iloc[:, 1]
    out.iloc[:, _pos0("L")] = lmn_df.iloc[:, 0]
    out.iloc[:, _pos0("M")] = lmn_df.iloc[:, 1]
    out.iloc[:, _pos0("N")] = lmn_df.iloc[:, 2]
    out.iloc[:, _pos0("O")] = 1
    out.iloc[:, _pos0("BG")] = series_h

    return _save_as_xls_bytes(out)
