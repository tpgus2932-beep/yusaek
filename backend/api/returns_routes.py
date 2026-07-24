import io
import asyncio
import json
import re
import shutil
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pandas as pd
import xlwt
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from typing import List
from fastapi.responses import FileResponse

try:
    from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
    from sdk.ably import AblyClient
except ModuleNotFoundError:  # package import in unit tests
    from backend.sdk.ezadmin import EzAdminClient, EzAdminSessionExpired
    from backend.sdk.ably import AblyClient

from api.wonbe_routes import load_wonbe_option_sno_map, _get_wonbe_db

LLOGIS_LOGIN_URL  = "https://partner.alps.llogis.com/auth/login"
LLOGIS_PID_BASE   = "https://pid.alps.llogis.com:18210"
LLOGIS_ACCOUNTS = {
    "348867": {"principal": "348867", "credential": "1q2w3e4r5t", "cust_cd": "348867", "cust_nm": "주식회사 영신디앤아이"},
    "331595": {"principal": "331595", "credential": "plan123!", "cust_cd": "331595", "cust_nm": "바브"},
}

ABLY_BASE     = "https://api.a-bly.com"
ABLY_EMAIL    = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_KST = timezone(timedelta(hours=9))
_BROWSER_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_BROWSER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

_SELLER_REASON_CODES   = {32, 1}  # 상품 하자/오배송, 셀러 변경
_SELLER_EXCHANGE_CODES = {2, 3}   # 상품 하자, 오배송 → 판매자 부담

_CANCEL_REASON_TEXT = {
    30: "단순변심",
    31: "사이즈/색상 불만족",
    32: "상품 하자/오배송",
    1:  "셀러 변경",
}


def _remove_return_queue_ids(state, remove_ids: set) -> None:
    """큐들에서 remove_ids에 해당하는 항목을 제거한다.

    scanned_barcodes는 큐와 별도로 "이번 세션에 스캔한 바코드" 기록을 유지하는데,
    여기서 같이 정리해주지 않으면 삭제한 항목을 재스캔했을 때 다른 큐에 같은
    바코드의 항목이 하나도 안 남았는데도 계속 "중복"으로 처리된다. 삭제 후 남은
    바코드(all_items 기준)와 비교해서, 완전히 사라진 바코드만 scanned_barcodes에서 뺀다.
    """
    removed_scans = set()
    for attr in (
        "queue_seller", "queue_customer", "queue_unmatched",
        "queue_exchange_seller", "queue_exchange_customer",
        "queue_exchange", "all_items",
    ):
        queue = getattr(state, attr)
        kept = []
        for it in queue:
            if it.get("id") in remove_ids:
                scan = it.get("scan")
                if scan:
                    removed_scans.add(scan)
            else:
                kept.append(it)
        setattr(state, attr, kept)

    if removed_scans:
        remaining_scans = {it.get("scan") for it in state.all_items if it.get("scan")}
        state.scanned_barcodes -= (removed_scans - remaining_scans)


def _wonbe_product_info(codes: list[str]) -> dict[str, dict]:
    """상품코드 목록으로 원가베이스유(wonbe)에서 상품명/색상/사이즈를 한 번에 조회."""
    if not codes:
        return {}
    conn = _get_wonbe_db()
    try:
        placeholders = ",".join(["?"] * len(codes))
        rows = conn.execute(
            f"SELECT 상품코드, 상품명, 색상, 사이즈 FROM wonbe WHERE 상품코드 IN ({placeholders})",
            codes,
        ).fetchall()
        return {r["상품코드"]: dict(r) for r in rows}
    finally:
        conn.close()


def build_returns_router(
    *,
    get_current_user,
    require_admin,
    get_return_state,
    get_db,
    get_setting,
    return_status,
    return_queue_payload,
    return_rows,
    return_state_to_payload,
    load_return_state_from_payload,
    load_return_cost_base,
    load_cost_base_df,
    save_cost_base_df,
    read_return_excel,
    clean_invoice,
    clean_product_name,
    lowercase_size_words,
    option_slash_to_space,
    clean_qty,
    normalize_spaces,
    reason_type,
    normalize_key,
    content_disposition,
    return_allowed_exts,
):
    router = APIRouter()
    COST_BASE_CODE_COL = 0
    COST_BASE_MATCH_COL = 8
    COST_BASE_REQUIRED_COLS = COST_BASE_MATCH_COL + 1
    COST_BASE_EDIT_COLS = [COST_BASE_CODE_COL, COST_BASE_MATCH_COL]

    def _df_value_to_xls_cell(value):
        if pd.isna(value):
            return ""
        if isinstance(value, bool):
            return bool(value)
        if isinstance(value, (int, float)):
            return value
        return str(value)

    def _cost_base_edit_col_name(df: pd.DataFrame, column):
        if isinstance(column, int):
            if column < 0 or column >= len(COST_BASE_EDIT_COLS):
                raise ValueError("column 범위를 벗어났습니다.")
            real_col_index = COST_BASE_EDIT_COLS[column]
            if real_col_index >= len(df.columns):
                raise ValueError("원가베이스는 최소 A~I열이 필요합니다.")
            return df.columns[real_col_index]
        if isinstance(column, str):
            if column == "A열 상품코드":
                return df.columns[COST_BASE_CODE_COL]
            if column == "I열 상품명 색상 사이즈":
                return df.columns[COST_BASE_MATCH_COL]
            if column in df.columns:
                return column
        raise ValueError("유효하지 않은 column 입니다.")

    def _build_xls_bytes_from_sheets(sheets: list[tuple[str, pd.DataFrame]]) -> bytes:
        try:
            import xlwt
        except Exception:
            raise HTTPException(status_code=400, detail="xls 저장을 위해 xlwt 설치가 필요합니다.")

        book = xlwt.Workbook()
        for sheet_name, df in sheets:
            safe_name = (sheet_name or "Sheet1")[:31]
            ws = book.add_sheet(safe_name)

            cols = [str(c) for c in list(df.columns)]
            for c_idx, col in enumerate(cols):
                ws.write(0, c_idx, col)

            for r_idx, row in enumerate(df.itertuples(index=False, name=None), start=1):
                for c_idx, value in enumerate(row):
                    ws.write(r_idx, c_idx, _df_value_to_xls_cell(value))

        buf = io.BytesIO()
        book.save(buf)
        return buf.getvalue()

    def _build_onebe_im25_xls_bytes(df: pd.DataFrame) -> tuple[bytes, int]:
        if df is None or df.empty:
            raise HTTPException(status_code=400, detail="원베양식 데이터가 없습니다.")
        if "상품코드" not in df.columns:
            raise HTTPException(status_code=400, detail="원베양식에 상품코드 열이 없습니다.")

        qty_col = "입고수량" if "입고수량" in df.columns else "수량" if "수량" in df.columns else "요청수량"
        if qty_col not in df.columns:
            raise HTTPException(status_code=400, detail="원베양식에 수량 열이 없습니다.")

        rows: list[tuple[str, object, object]] = []
        for _, row in df.iterrows():
            code = str(row.get("상품코드") or "").strip()
            if not code or code.lower() in ("nan", "none"):
                continue

            raw_qty = row.get(qty_col)
            try:
                qty = int(float(str(raw_qty).replace(",", "").strip()))
            except Exception:
                qty = 0
            if qty <= 0:
                continue

            req_qty = row.get("요청수량", 0)
            try:
                req_qty = int(float(str(req_qty).replace(",", "").strip()))
            except Exception:
                req_qty = 0
            rows.append((code, req_qty, qty))

        if not rows:
            raise HTTPException(status_code=400, detail="상품코드와 수량이 있는 원베양식 행이 없습니다.")

        book = xlwt.Workbook()
        sheet = book.add_sheet("상품일괄추가")
        headers = ["상품코드", "요청수량", "입고수량"]
        for col_idx, header in enumerate(headers):
            sheet.write(0, col_idx, header)
        for row_idx, (code, req_qty, qty) in enumerate(rows, start=1):
            sheet.write(row_idx, 0, code)
            sheet.write(row_idx, 1, req_qty)
            sheet.write(row_idx, 2, qty)

        buf = io.BytesIO()
        book.save(buf)
        return buf.getvalue(), len(rows)

    def _browser_time_flag(now: datetime) -> str:
        return (
            f"{_BROWSER_WEEKDAYS[now.weekday()]} "
            f"{_BROWSER_MONTHS[now.month - 1]} "
            f"{now.day:02d} {now.year} "
            f"{now:%H:%M:%S} GMT+0900 (한국 표준시)"
        )

    def _looks_like_ezadmin_session_error(response: httpx.Response, body: str) -> bool:
        lowered = (body or "").lower()
        if response.url and "login" in str(response.url).lower():
            return True
        if "<html" in lowered or "<!doctype html" in lowered:
            return True
        return any(token in lowered for token in ("login", "phpsessid", "session", "로그인"))

    def _looks_like_ezadmin_login_page(response: httpx.Response, body: str) -> bool:
        lowered = (body or "").lower()
        if response.url and "login" in str(response.url).lower():
            return True
        return "login.htm" in lowered or "login_form" in lowered

    async def _find_ezadmin_sheet_seq(
        client: httpx.AsyncClient,
        *,
        phpsessid: str,
        start_date: str,
        sheet_title: str,
    ) -> str | None:
        response = await client.post(
            f"{_EZADMIN_BASE}/function.htm",
            data={
                "_search": "false",
                "nd": str(int(datetime.now(_KST).timestamp() * 1000)),
                "rows": "9999",
                "page": "1",
                "sidx": "",
                "sord": "asc",
                "template": "IM00",
                "action": "get_IM00_grid",
                "par": (
                    "template=IM00&action=&page_code=IM00&search=1"
                    "&_sort=&sort_order=&date_type=crdate"
                    f"&start_date={start_date}&end_date={start_date}"
                    "&date_period_sel=0&query_option=title&query_str=&req_status=0"
                ),
            },
            cookies={"PHPSESSID": phpsessid},
            headers={"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest"},
        )
        body = response.text or ""
        if _looks_like_ezadmin_session_error(response, body):
            return None
        try:
            obj = response.json()
        except Exception:
            return None

        html_tag = re.compile(r"<[^>]+>")
        matches: list[str] = []
        for row in obj.get("rows", []):
            cell = row.get("cell", {}) or {}
            clean = {
                key: html_tag.sub("", str(value)).strip() if isinstance(value, str) else value
                for key, value in cell.items()
            }
            title = str(clean.get("title") or clean.get("sheet_title") or "").strip()
            if title and title != sheet_title:
                continue
            sheet_no = str(cell.get("sheet") or clean.get("sheet") or "").strip()
            for value in cell.values():
                if sheet_no:
                    break
                if isinstance(value, str):
                    match = re.search(r"sheet=['\"]?(\w+)['\"]?", value, re.IGNORECASE)
                    if match:
                        sheet_no = match.group(1)
            if sheet_no:
                matches.append(sheet_no)

        def sort_key(value: str):
            try:
                return int(value)
            except Exception:
                return 0

        return sorted(matches, key=sort_key)[-1] if matches else None

    def _clean_exchange_reason(value) -> str:
        if value is None or pd.isna(value):
            return ""
        text = str(value).strip()
        if text.lower() in ("nan", "none"):
            return ""
        parts = [part.strip() for part in re.split(r"[\r\n]+", text) if part.strip()]
        return normalize_spaces(" ".join(parts))

    def _exchange_type(reason: str) -> str:
        text = normalize_spaces(reason or "")
        if "판매자" in text:
            return "교환판매자"
        if "구매자" in text or "고객" in text:
            return "교환고객"
        return "교환고객"

    def _exchange_sound_type(exchange_type: str) -> str:
        return "교환불량" if exchange_type == "교환판매자" else "교환정상"

    def _clean_sno(value) -> str:
        """sno류 값을 문자열로 정리 (DataFrame에서 float로 승격된 경우 .0 제거)."""
        if value is None:
            return ""
        try:
            if pd.isna(value):
                return ""
        except (TypeError, ValueError):
            pass
        text = str(value).strip()
        if text.lower() in ("nan", "none", ""):
            return ""
        if text.endswith(".0"):
            text = text[:-2]
        return text

    def _find_related_unscanned(df, order_key_col: str, order_keys: set, invoice_col: str, matched_invoices: set) -> list[dict]:
        """같은 order_key(주문번호)를 가진, 아직 큐에 없는 다른 행들을 찾는다.

        반품/교환이 같은 주문번호로 여러 건 나눠 접수됐지만 물리적으로 한
        번에 도착하는 경우, 하나 스캔했을 때 나머지도 같이 추가할지 물어볼
        수 있도록 후보를 돌려준다. ``matched_invoices``는 이미 큐에 들어간
        항목들의 ``match`` 값 집합 - 스캔된 물리적 바코드가 아니라 실제로
        어떤 행이 큐에 반영됐는지로 판단해야 CJ/롯데 송장 ↔ 에이블리 송장
        간 매핑 차이에 영향을 안 받는다.
        """
        if df is None or df.empty or not order_keys:
            return []
        related = []
        seen = set()
        for _, r in df.iterrows():
            key = _clean_sno(r.get(order_key_col))
            if not key or key not in order_keys:
                continue
            inv = r.get(invoice_col, "")
            if not inv or inv in seen or inv in matched_invoices:
                continue
            seen.add(inv)
            related.append({"invoice": inv, "item_text": r.get("ITEM_TEXT", ""), "qty": r.get("QTY", "")})
        return related

    def _to_int(v):
        try:
            return int(v) if v is not None and str(v).lower() not in ("nan", "none", "") else None
        except (ValueError, TypeError):
            return None

    def _resolve_lotte_request_memo(state, scan: str, fallback: str = "") -> str:
        key = clean_invoice(scan)
        if key and getattr(state, "map_lotte", None):
            return state.map_lotte.get(key, "") or fallback
        return fallback

    def _is_exchange_item(item: dict) -> bool:
        return bool(item.get("sound_type") or "reason" in item)

    def _request_memo_for_item(state, item: dict) -> str:
        fallback = item.get("match", "")
        if _is_exchange_item(item):
            return _resolve_lotte_request_memo(state, item.get("scan", ""), fallback)
        return fallback

    @router.get("/returns/state")
    def returns_state(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        conn = get_db()
        row = conn.execute(
            "SELECT updated_at FROM return_saved_states WHERE username = ?",
            (user,),
        ).fetchone()
        conn.close()
        return {
            "ok": True,
            "status": return_status(state),
            "queues": return_queue_payload(state),
            "onebe": {
                "rows": return_rows(state.customer_export_df),
            },
            "last_type": state.last_type,
            "scanned_count": len(state.scanned_barcodes),
            "saved_at": row["updated_at"] if row else None,
        }

    @router.post("/returns/save")
    def returns_save(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        payload = json.dumps(return_state_to_payload(state), ensure_ascii=False)
        updated_at = datetime.now(timezone.utc).isoformat()
        conn = get_db()
        conn.execute(
            """
            INSERT INTO return_saved_states (username, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (user, payload, updated_at),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "saved_at": updated_at}

    @router.post("/returns/load")
    def returns_load(user: str = Depends(get_current_user)):
        conn = get_db()
        row = conn.execute(
            "SELECT payload, updated_at FROM return_saved_states WHERE username = ?",
            (user,),
        ).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="임시저장된 반품 상태가 없습니다.")
        state = get_return_state(user)
        payload = json.loads(row["payload"])
        load_return_state_from_payload(state, payload)
        return {
            "ok": True,
            "saved_at": row["updated_at"],
            "status": return_status(state),
            "queues": return_queue_payload(state),
            "onebe": {"rows": return_rows(state.customer_export_df)},
            "last_type": state.last_type,
            "scanned_count": len(state.scanned_barcodes),
        }

    @router.post("/returns/excel1")
    def returns_upload_excel1(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        tmp_path = Path(tempfile.gettempdir()) / f"returns_excel1_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            df = read_return_excel(tmp_path)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        if df.shape[1] < 5:
            raise HTTPException(status_code=400, detail="1번 엑셀에 D/E열이 없습니다. (열 개수가 부족)")

        df["D_clean"] = df.iloc[:, 3].apply(clean_invoice)
        df["E_clean"] = df.iloc[:, 4].apply(clean_invoice)

        mapping: dict[str, str] = {}
        for _, row in df.iterrows():
            d = row.get("D_clean", "")
            e = row.get("E_clean", "")
            if d and d not in mapping:
                mapping[d] = e

        state = get_return_state(user)
        state.df1 = df
        state.map_d_to_e = mapping
        return {"ok": True, "map_count": len(mapping), "status": return_status(state)}

    @router.post("/returns/excel_lotte")
    def returns_upload_excel_lotte(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        tmp_path = Path(tempfile.gettempdir()) / f"returns_excel_lotte_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            df = read_return_excel(tmp_path)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        if df.shape[1] < 8:
            raise HTTPException(status_code=400, detail="롯데택배 엑셀에 G/H열이 없습니다. (열 개수가 부족)")

        df["G_clean"] = df.iloc[:, 6].apply(clean_invoice)
        df["H_clean"] = df.iloc[:, 7].apply(clean_invoice)

        mapping: dict[str, str] = {}
        for _, row in df.iterrows():
            g = row.get("G_clean", "")
            h = row.get("H_clean", "")
            if g and g not in mapping:
                mapping[g] = h

        state = get_return_state(user)
        state.df_lotte = df
        state.map_lotte = mapping
        return {"ok": True, "map_count": len(mapping), "status": return_status(state)}

    @router.post("/returns/excel2")
    def returns_upload_excel2(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        tmp_path = Path(tempfile.gettempdir()) / f"returns_excel2_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            df = read_return_excel(tmp_path)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        if df.shape[1] < 13:
            raise HTTPException(status_code=400, detail="2번 엑셀에 필요한 열(F,G,H,K,M)이 없습니다. (열 개수가 부족)")

        df["F_name"] = df.iloc[:, 5].apply(clean_product_name)
        df["G_opt"] = df.iloc[:, 6].apply(lowercase_size_words).apply(option_slash_to_space)
        df["QTY"] = df.iloc[:, 7].apply(clean_qty)
        df["ITEM_TEXT"] = df.apply(lambda r: normalize_spaces(f"{r.get('F_name','')} {r.get('G_opt','')}"), axis=1)
        df["REASON_TYPE"] = df.iloc[:, 10].apply(reason_type)
        df["M_clean"] = df.iloc[:, 12].apply(clean_invoice)

        idx: dict[str, list[int]] = {}
        for i, v in enumerate(df["M_clean"].tolist()):
            if not v:
                continue
            idx.setdefault(v, []).append(i)

        state = get_return_state(user)
        state.df2 = df
        state.df2_index = idx
        return {"ok": True, "index_count": len(idx), "status": return_status(state)}

    async def _ably_login() -> str:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/login/",
                json={"email": ABLY_EMAIL, "password": ABLY_PASSWORD},
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://seller-admin.a-bly.com",
                    "Referer": "https://seller-admin.a-bly.com/",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            res.raise_for_status()
        token = res.json().get("token")
        if not token:
            raise HTTPException(status_code=502, detail="에이블리 로그인 실패")
        return token

    def _ably_seller_headers(token: str) -> dict:
        return {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://seller-admin.a-bly.com",
            "Referer": "https://seller-admin.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

    async def _ably_receive_exchanges(token: str, exchange_snos: list[int]) -> dict:
        """교환수거중(status=3) -> 수거완료(status=4). 실제 브라우저 캡처로 확인된 엔드포인트."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/exchanges/receive/",
                headers=_ably_seller_headers(token),
                json={"exchange_snos": exchange_snos},
            )
        res.raise_for_status()
        return res.json()

    async def _ably_prepare_exchanges(token: str, exchange_snos: list[int]) -> dict:
        """수거완료(status=4) -> 교환상품준비중(status=9). 실제 브라우저 캡처로 확인된 엔드포인트."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(
                f"{ABLY_BASE}/seller/exchanges/prepare/",
                headers=_ably_seller_headers(token),
                json={"exchange_snos": exchange_snos},
            )
        res.raise_for_status()
        return res.json()

    async def _fetch_ably_exchange_sno_map(token: str) -> dict:
        """status=3/4(수거중/수거완료) 교환건을 order_sno·수거송장 기준으로 exchange_sno에 매핑.

        exchange_sno 필드를 이 기능 배포 전에 스캔해 둔 큐 항목에는 채워줄 수
        없으므로(당시엔 저장 안 됐음), 실행 시점에 최신 목록을 다시 불러와
        order_sno/반품송장으로 역매칭해 채운다.
        """
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
        }
        today_dt = datetime.now(timezone.utc).date()
        start_dt = today_dt - timedelta(days=365)
        by_order_sno: dict[str, int] = {}
        by_invoice: dict[str, int] = {}
        async with httpx.AsyncClient(timeout=30.0) as client:
            page = 1
            while True:
                res = await client.get(
                    f"{ABLY_BASE}/seller/exchanges/",
                    headers=headers,
                    params={
                        "page": page,
                        "per_page": 30,
                        "requested_at_start": f"{start_dt.strftime('%Y-%m-%d')} 00:00:00",
                        "requested_at_end": f"{today_dt.strftime('%Y-%m-%d')} 23:59:59",
                        "status[]": [3, 4],
                    },
                )
                res.raise_for_status()
                data = res.json()
                exchanges = data.get("exchanges", [])
                if not exchanges:
                    break
                for ex in exchanges:
                    sno = ex.get("exchange_sno") or ex.get("sno")
                    if not sno:
                        continue
                    order_sno = str(ex.get("order_sno") or "").strip()
                    if order_sno:
                        by_order_sno[order_sno] = sno
                    invoice = clean_invoice(str((ex.get("return_delivery") or {}).get("invoice_number") or ""))
                    if invoice:
                        by_invoice[invoice] = sno
                if page >= data.get("max_page_number", 1):
                    break
                page += 1
        return {"by_order_sno": by_order_sno, "by_invoice": by_invoice}

    @router.post("/returns/load-ably-api")
    async def load_ably_api(user: str = Depends(get_current_user)):
        try:
            token = await _ably_login()
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        today_dt = datetime.now(timezone.utc).date()
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
        }

        start_dt = today_dt - timedelta(days=365)
        all_raw = []

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                page = 1
                while True:
                    res = await client.get(
                        f"{ABLY_BASE}/seller/order_cancels/",
                        headers=headers,
                        params={
                            "cancel_type": "return",
                            "processing_sub_status[]": ["41", "42"],
                            "delivery_type[]": ["standard", "today", "combine", "reserved"],
                            "order": "cancel_received_at",
                            "page": page,
                            "per_page": 30,
                            "start_date": start_dt.strftime("%Y-%m-%d"),
                            "end_date": today_dt.strftime("%Y-%m-%d"),
                        },
                    )
                    res.raise_for_status()
                    data = res.json()
                    cancels = data.get("order_cancels", [])
                    if not cancels:
                        break
                    for cancel in cancels:
                        cancel_sno        = str(cancel.get("sno") or "")
                        refund_holder     = str(cancel.get("refund_bank_account_holder") or "")
                        refund_account    = str(cancel.get("refund_bank_account_number") or "")
                        refund_bank_sno   = cancel.get("refund_bank_sno")
                        for item in cancel.get("order_items", []):
                            item["_cancel_reason"]   = item.get("cancel_reason")
                            item["_cancel_sno"]      = cancel_sno
                            item["_item_sno"]        = item.get("sno")
                            item["_refund_holder"]   = refund_holder
                            item["_refund_account"]  = refund_account
                            item["_refund_bank_sno"] = refund_bank_sno
                            # buyer_tel/receiver_tel은 order_item 단위 필드다 (cancel
                            # 최상위가 아님 - 실제 API 응답으로 확인됨, HAR 캡처 기준).
                            item["_buyer_tel"]       = str(item.get("buyer_tel") or item.get("receiver_tel") or "")
                            # 고객이 반품 신청 시 첨부한 사진. user_comment와 마찬가지로
                            # order_item 단위 필드다 (cancel 최상위가 아님 - cancel
                            # 레벨에서 읽으면 항상 빈 배열이 돼서 seller 큐에 사진이 전혀
                            # 안 뜨는 버그가 있었음).
                            item["_cancel_images"]   = item.get("cancel_images") or cancel.get("cancel_images") or []
                            # order_id 필드는 실제로 존재하지 않는다 (order_items에는
                            # order_sno만 있음 - 직접 API 응답으로 확인됨). order_id를
                            # 쓰면 항상 빈 값이라 "같은 주문번호" 매칭이 절대 안 걸림.
                            item["_order_no"]        = str(item.get("order_sno") or "")
                            all_raw.append(item)
                    if page >= data.get("max_page_number", 1):
                        break
                    page += 1
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"반품 목록 조회 실패: {e}")

        rows = []
        for item in all_raw:
            f_name  = clean_product_name(item.get("goods_name") or "")
            g_opt   = option_slash_to_space(lowercase_size_words(item.get("option_info") or ""))
            qty     = str(item.get("ea") or 1)
            m_clean = clean_invoice(str(item.get("invoice") or ""))
            fee           = item.get("return_delivery_fee")
            rtype         = "고객" if (fee is not None and fee < 0) else "판매자"
            reason_code   = item.get("_cancel_reason")
            detail_reason = _CANCEL_REASON_TEXT.get(reason_code, f"기타({reason_code})" if reason_code is not None else "")
            user_comment  = item.get("user_comment") or ""
            rows.append({
                "F_name":         f_name,
                "G_opt":          g_opt,
                "QTY":            qty,
                "ITEM_TEXT":      normalize_spaces(f"{f_name} {g_opt}"),
                "REASON_TYPE":    rtype,
                "M_clean":        m_clean,
                "DETAIL_REASON":  detail_reason,
                "USER_COMMENT":   user_comment,
                "REQUEST_NO":     item.get("_cancel_sno", ""),
                "ITEM_SNO":       item.get("_item_sno"),
                "REFUND_HOLDER":  item.get("_refund_holder", ""),
                "REFUND_ACCOUNT": item.get("_refund_account", ""),
                "REFUND_BANK_SNO": item.get("_refund_bank_sno"),
                "BUYER_TEL":      item.get("_buyer_tel", ""),
                "ORDER_NO":       item.get("_order_no", ""),
                "CANCEL_IMAGES":  item.get("_cancel_images") or [],
                "OPTION_CODE":    str(item.get("option_stock_sync_code") or ""),
                "GOODS_NAME":     f_name,
                "OPTION_RAW":     str(item.get("option_info") or "").strip(),
            })

        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "REASON_TYPE", "M_clean", "DETAIL_REASON", "USER_COMMENT", "REQUEST_NO", "ITEM_SNO", "REFUND_HOLDER", "REFUND_ACCOUNT", "REFUND_BANK_SNO", "BUYER_TEL", "ORDER_NO", "CANCEL_IMAGES", "OPTION_CODE", "GOODS_NAME", "OPTION_RAW"])
        idx: dict[str, list[int]] = {}
        for i, v in enumerate(df["M_clean"].tolist()):
            if v:
                idx.setdefault(v, []).append(i)

        state = get_return_state(user)
        state.df2 = df
        state.df2_index = idx
        return {"ok": True, "loaded": len(rows), "index_count": len(idx), "status": return_status(state)}

    @router.post("/returns/load-exchange-api")
    async def load_exchange_api(user: str = Depends(get_current_user)):
        try:
            token = await _ably_login()
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 로그인 실패: {e}")

        today_dt = datetime.now(timezone.utc).date()
        headers = {
            "Authorization": f"JWT {token}",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
        }

        start_dt = today_dt - timedelta(days=365)
        all_raw = []

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                page = 1
                while True:
                    res = await client.get(
                        f"{ABLY_BASE}/seller/exchanges/",
                        headers=headers,
                        params={
                            "page": page,
                            "per_page": 30,
                            "requested_at_start": f"{start_dt.strftime('%Y-%m-%d')} 00:00:00",
                            "requested_at_end": f"{today_dt.strftime('%Y-%m-%d')} 23:59:59",
                            "status[]": [3, 4],
                        },
                    )
                    res.raise_for_status()
                    data = res.json()
                    exchanges = data.get("exchanges", [])
                    if not exchanges:
                        break
                    all_raw.extend(exchanges)
                    if page >= data.get("max_page_number", 1):
                        break
                    page += 1
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"교환 목록 조회 실패: {e}")

        rows = []
        for ex in all_raw:
            rd = ex.get("return_delivery") or {}
            t_raw = rd.get("invoice_number")
            if not t_raw:
                continue  # 수거 송장 미등록 → 스캔 불가, 스킵

            items_list = ex.get("exchange_items") or []
            if not items_list:
                continue

            # 한 exchange_sno 안에 exchange_items가 여러 개 들어있는 경우가
            # 있다 (예: 같은 상품을 2개 교환신청 - 각각 다른 order_item.sno,
            # 같은 수거송장 하나로 묶여서 온다). items_list[0]만 쓰면 나머지
            # 라인이 통째로 사라지므로 라인아이템 단위로 각각 행을 만든다.
            reason_code   = ex.get("reason_code")
            rtype         = "판매자" if reason_code in _SELLER_EXCHANGE_CODES else "구매자"
            detail_reason = ex.get("detail_reason") or ""
            reason_images = ex.get("exchange_reason_image_urls") or []
            t_clean       = clean_invoice(str(t_raw))
            # order_sno는 exchange 최상위 필드가 신뢰 가능 (order_item.order_sno는
            # 자주 비어 있음 - exchange_return_routes.py에서 이미 검증된 패턴).
            order_sno     = ex.get("order_sno")
            exchange_sno  = ex.get("exchange_sno") or ex.get("sno")
            ex_status     = ex.get("status")

            for exchange_item in items_list:
                order_item = exchange_item.get("order_item") or {}

                goods_name    = order_item.get("goods_name") or exchange_item.get("goods_name") or ""
                option_values = (order_item.get("original_goods_option") or {}).get("option_values") or []
                option_parts  = []
                for v in option_values:
                    if isinstance(v, dict):
                        option_parts.append(str(v.get("value") or v.get("name") or ""))
                    else:
                        option_parts.append(str(v))
                option_str = "/".join(p for p in option_parts if p)
                qty        = str(order_item.get("quantity") or 1)

                f_name = clean_product_name(goods_name)
                g_opt  = option_slash_to_space(lowercase_size_words(option_str))

                order_item_sno      = order_item.get("sno")
                exchange_option_sno = (exchange_item.get("exchange_goods_option") or {}).get("sno")

                rows.append({
                    "F_name":              f_name,
                    "G_opt":               g_opt,
                    "QTY":                 qty,
                    "ITEM_TEXT":           normalize_spaces(f"{f_name} {g_opt}"),
                    "EXCHANGE_REASON":     rtype,
                    "T_clean":             t_clean,
                    "DETAIL_REASON":       detail_reason,
                    "ORDER_SNO":           order_sno,
                    "ORDER_ITEM_SNO":      order_item_sno,
                    "EXCHANGE_OPTION_SNO": exchange_option_sno,
                    "EXCHANGE_SNO":        exchange_sno,
                    "EXCHANGE_STATUS":     ex_status,
                    "REASON_IMAGES":       reason_images,
                    "GOODS_NAME":          f_name,
                    "OPTION_RAW":          option_str,
                })

        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "EXCHANGE_REASON", "T_clean", "DETAIL_REASON",
                     "ORDER_SNO", "ORDER_ITEM_SNO", "EXCHANGE_OPTION_SNO", "EXCHANGE_SNO", "EXCHANGE_STATUS", "REASON_IMAGES",
                     "GOODS_NAME", "OPTION_RAW"])
        idx: dict[str, list[int]] = {}
        for i, v in enumerate(df["T_clean"].tolist()):
            if v:
                idx.setdefault(v, []).append(i)

        state = get_return_state(user)
        state.exchange_df    = df
        state.exchange_index = idx
        return {"ok": True, "loaded": len(rows), "index_count": len(idx), "status": return_status(state)}

    @router.post("/returns/exchange-customer/resolve-ezadmin")
    async def resolve_exchange_customer_ezadmin(queue: str = "customer", user: str = Depends(get_current_user)):
        """교환고객/교환판매자 큐 각 항목의 order_sno로 이지어드민 SEQ/PRD_SEQ/기존상품코드를,
        exchange_option_sno로 원가베이스유의 옵션번호를 대조해 교환할 신규상품코드를 찾는다.

        반품송장 → LOGIS 원송장조회 → CS검색을 거치지 않고, 에이블리 교환
        데이터에 이미 있는 order_sno/옵션sno만으로 바로 해결한다.
        """
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        items = state.queue_exchange_seller if queue == "seller" else state.queue_exchange_customer
        if not items:
            return {"ok": True, "resolved": 0, "queues": return_queue_payload(state)}

        ez = EzAdminClient(get_setting)
        option_sno_map = load_wonbe_option_sno_map()

        now = datetime.now(_KST)
        start_date = (now - timedelta(days=365)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        pack_cache: dict[str, str | None] = {}
        packlist_cache: dict[str, list[dict]] = {}
        resolved = 0

        for item in items:
            order_sno = str(item.get("order_sno") or "").strip()
            if not order_sno:
                item["ezadmin_error"] = "order_sno 없음 (엑셀 업로드 건은 지원 안 함)"
                continue

            try:
                if order_sno not in pack_cache:
                    pack_cache[order_sno] = await ez.find_pack_by_order_sno(
                        order_sno, start_date=start_date, end_date=end_date
                    )
                pack = pack_cache[order_sno]
                if not pack:
                    item["ezadmin_error"] = f"이지어드민 주문 검색결과 없음 (order_sno={order_sno})"
                    continue

                if pack not in packlist_cache:
                    packlist_cache[pack] = await ez.packlist_items(pack)
                line_items = packlist_cache[pack]

                order_item_sno = str(item.get("order_item_sno") or "").strip()
                matched = None
                if order_item_sno:
                    matched = next(
                        (li for li in line_items if str(li.get("order_id_seq") or "") == order_item_sno),
                        None,
                    )
                if matched is None and len(line_items) == 1:
                    matched = line_items[0]
                if matched is None:
                    item["ezadmin_error"] = f"주문상품 라인 매칭 실패 (pack={pack})"
                    continue

                item["ezadmin_seq"] = pack
                item["ezadmin_prd_seq"] = matched.get("prd_seq")
                item["old_product_id"] = matched.get("product_id")

                exchange_option_sno = str(item.get("exchange_option_sno") or "").strip()
                new_product_id = option_sno_map.get(exchange_option_sno) if exchange_option_sno else None
                item["new_product_id"] = new_product_id
                if not new_product_id:
                    item["ezadmin_error"] = (
                        f"원가베이스유에서 옵션번호 매칭 실패 (sno={exchange_option_sno})" if exchange_option_sno
                        else "exchange_option_sno 없음"
                    )
                else:
                    item.pop("ezadmin_error", None)
                resolved += 1
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "resolved": resolved, "queues": return_queue_payload(state)}
            except Exception as e:
                item["ezadmin_error"] = str(e)[:200]

        return {"ok": True, "resolved": resolved, "queues": return_queue_payload(state)}

    @router.post("/returns/exchange-customer/execute-change-product")
    async def execute_exchange_customer_change_product(queue: str = "customer", user: str = Depends(get_current_user)):
        """resolve-ezadmin으로 SEQ/PRD_SEQ/기존상품코드/교환상품코드가 모두 채워진
        교환고객/교환판매자 항목들에 대해 이지어드민 change_product(E900)를 실제로 실행한다.

        주문의 상품을 즉시 교체하는, 되돌리기 어려운 동작이다 - 값이 하나라도
        비어있거나 에러가 있는 항목은 건너뛴다.
        """
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        items = state.queue_exchange_seller if queue == "seller" else state.queue_exchange_customer
        pending = [
            item for item in items
            if not item.get("change_product_done")
            and not item.get("ezadmin_error")
            and item.get("ezadmin_seq") and item.get("ezadmin_prd_seq")
            and item.get("old_product_id") and item.get("new_product_id")
        ]
        # 이미 change_product_done인데 에이블리 상태 전환이 아직 안 된 항목도 있을 수
        # 있다 (이 기능 배포 전에 이지어드민 교환처리만 끝난 건). pending이 비어도
        # 그런 항목이 있으면 바로 끝내지 않고 아래 에이블리 전환 단계까지 진행한다.
        already_needing_advance = [
            item for item in items
            if item.get("change_product_done") and not item.get("ably_advance_done")
        ]
        if not pending and not already_needing_advance:
            return {"ok": False, "detail": "실행 가능한(모든 값이 채워진) 항목이 없습니다.", "queues": return_queue_payload(state)}

        ez = EzAdminClient(get_setting)
        executed = 0

        for item in pending:
            try:
                qty = int(float(item.get("qty") or 1))
            except (TypeError, ValueError):
                qty = 1
            try:
                result = await ez.change_product(
                    item["ezadmin_seq"],
                    item["ezadmin_prd_seq"],
                    product_id=item["new_product_id"],
                    old_product_id=item["old_product_id"],
                    qty=qty,
                    reason=str(item.get("detail_reason") or item.get("reason") or ""),
                )
                if result.get("error") in (0, "0"):
                    item["change_product_done"] = True
                    item.pop("ezadmin_error", None)
                    executed += 1
                else:
                    item["ezadmin_error"] = f"이지어드민 교환처리 실패: {result}"
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "executed": executed, "queues": return_queue_payload(state)}
            except Exception as e:
                item["ezadmin_error"] = str(e)[:200]

        # 이지어드민 상품교환처리가 끝난 건(이번 배치 + 예전에 이미 끝나 있던 건 모두)은
        # 에이블리 교환 상태도 같이 넘겨준다. 수거중(3)이면 수거완료(4)를 거쳐, 수거완료(4)면
        # 바로 교환상품준비중(9)으로 보낸다. exchange_sno가 없는 항목(이 기능 배포 전에
        # 스캔된 건)은 order_sno/반품송장으로 최신 목록에서 역매칭해 채운다.
        ably_advanced = {"received": 0, "prepared": 0}
        ably_error = None
        advance_candidates = [
            item for item in items
            if item.get("change_product_done") and not item.get("ably_advance_done")
        ]
        if advance_candidates:
            try:
                token = await _ably_login()
            except Exception as e:
                ably_error = f"에이블리 로그인 실패: {str(e)[:200]}"
                token = None

            if token:
                missing = [item for item in advance_candidates if not item.get("exchange_sno")]
                if missing:
                    try:
                        sno_map = await _fetch_ably_exchange_sno_map(token)
                        for item in missing:
                            order_sno = str(item.get("order_sno") or "").strip()
                            invoice = clean_invoice(str(item.get("match") or item.get("scan") or ""))
                            found = sno_map["by_order_sno"].get(order_sno) or sno_map["by_invoice"].get(invoice)
                            if found:
                                item["exchange_sno"] = str(found)
                    except Exception as e:
                        ably_error = f"에이블리 교환건 조회 실패: {str(e)[:200]}"

                resolved = [item for item in advance_candidates if item.get("exchange_sno")]
                unresolved_count = len(advance_candidates) - len(resolved)
                exchange_snos = sorted({int(item["exchange_sno"]) for item in resolved})

                if exchange_snos:
                    try:
                        receive_result = await _ably_receive_exchanges(token, exchange_snos)
                        ably_advanced["received"] = receive_result.get("success_count") or 0
                    except Exception:
                        pass  # 이미 수거완료 이후 상태인 항목이 섞여 있으면 실패할 수 있음 - prepare로 계속 진행
                    try:
                        prepare_result = await _ably_prepare_exchanges(token, exchange_snos)
                        ably_advanced["prepared"] = prepare_result.get("success_count") or 0
                        for item in resolved:
                            item["ably_advance_done"] = True
                    except Exception as e:
                        ably_error = f"교환상품준비중 처리 실패: {str(e)[:200]}"

                if unresolved_count and not ably_error:
                    ably_error = f"exchange_sno를 찾지 못해 에이블리 상태 전환을 건너뛴 항목 {unresolved_count}건"

        return {
            "ok": True,
            "executed": executed,
            "ably_advanced": ably_advanced,
            "ably_error": ably_error,
            "queues": return_queue_payload(state),
        }

    @router.post("/returns/exchange")
    def returns_upload_exchange(
        files: List[UploadFile] = File(...),
        user: str = Depends(get_current_user),
    ):
        dfs = []
        for file in files:
            ext = Path(file.filename or "").suffix.lower()
            if ext not in return_allowed_exts:
                raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

            tmp_path = Path(tempfile.gettempdir()) / f"returns_exchange_{uuid.uuid4().hex}{ext}"
            with tmp_path.open("wb") as out:
                shutil.copyfileobj(file.file, out)

            try:
                df = read_return_excel(tmp_path)
            finally:
                try:
                    tmp_path.unlink(missing_ok=True)
                except Exception:
                    pass

            if df.shape[1] < 20:
                raise HTTPException(status_code=400, detail=f"{file.filename}: 교환 엑셀에 필요한 열(F,G,I,J,T)이 없습니다. (열 개수가 부족)")

            dfs.append(df)

        df = pd.concat(dfs, ignore_index=True) if len(dfs) > 1 else dfs[0]

        df["F_name"] = df.iloc[:, 5].apply(clean_product_name)
        df["G_opt"] = df.iloc[:, 6].apply(lowercase_size_words).apply(option_slash_to_space)
        df["QTY"] = df.iloc[:, 8].apply(clean_qty)
        df["EXCHANGE_REASON"] = df.iloc[:, 9].apply(_clean_exchange_reason)
        df["ITEM_TEXT"] = df.apply(lambda r: normalize_spaces(f"{r.get('F_name','')} {r.get('G_opt','')}"), axis=1)
        df["T_clean"] = df.iloc[:, 19].apply(clean_invoice)

        idx: dict[str, list[int]] = {}
        for i, v in enumerate(df["T_clean"].tolist()):
            if not v:
                continue
            idx.setdefault(v, []).append(i)

        state = get_return_state(user)
        state.exchange_df = df
        state.exchange_index = idx
        return {"ok": True, "exchange_index_count": len(idx), "status": return_status(state)}

    @router.post("/returns/cost-base/reload")
    def returns_cost_base_reload(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        try:
            load_return_cost_base(state)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")
        return {"ok": True, "cost_count": len(state.cost_map), "status": return_status(state)}

    @router.get("/returns/cost-base/download")
    def returns_cost_base_download(admin: str = Depends(require_admin)):
        df = load_cost_base_df()
        if df.empty:
            raise HTTPException(status_code=404, detail="원가베이스 데이터가 없습니다.")
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": content_disposition("원가베이스유.xlsx")},
        )

    @router.get("/returns/cost-base/preview")
    def returns_cost_base_preview(
        offset: int = 0,
        limit: int = 50,
        q: str | None = None,
        user: str = Depends(get_current_user),
    ):
        if offset < 0 or limit <= 0 or limit > 200:
            raise HTTPException(status_code=400, detail="offset/limit 값이 올바르지 않습니다.")
        try:
            df = load_cost_base_df()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="Cost base requires columns A through I.")

        q_norm = str(q).strip() if q else ""
        if q_norm:
            df_view = df.fillna("").astype(str)
            mask = df_view.apply(lambda row: row.str.contains(q_norm, case=False, na=False)).any(axis=1)
            df_filtered = df[mask].copy()
        else:
            df_filtered = df

        total = len(df_filtered)
        col_names = ["상품코드", "상품명합"]
        end = min(offset + limit, total)
        rows = []
        for i in range(offset, end):
            r = df_filtered.iloc[i]
            row = []
            for v in [r.iloc[COST_BASE_CODE_COL], r.iloc[COST_BASE_MATCH_COL]]:
                if pd.isna(v):
                    row.append("")
                else:
                    row.append(v)
            rows.append({"row_index": int(r.name), "values": row})
        return {"ok": True, "columns": col_names, "rows": rows, "total": total}

    @router.post("/returns/cost-base/edit")
    def returns_cost_base_edit(payload: dict = Body(...), user: str = Depends(get_current_user)):
        row_index = payload.get("row_index")
        column = payload.get("column")
        value = payload.get("value")

        if row_index is None or not isinstance(row_index, int) or row_index < 0:
            raise HTTPException(status_code=400, detail="row_index가 올바르지 않습니다.")
        if not isinstance(column, (str, int)):
            raise HTTPException(status_code=400, detail="column 값이 올바르지 않습니다.")

        try:
            df = load_cost_base_df()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if row_index >= len(df):
            raise HTTPException(status_code=400, detail="row_index 범위를 벗어났습니다.")

        try:
            col_name = _cost_base_edit_col_name(df, column)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        df.at[row_index, col_name] = "" if value is None else value
        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        return {"ok": True}

    @router.post("/returns/cost-base/edit-batch")
    def returns_cost_base_edit_batch(payload: dict = Body(...), user: str = Depends(get_current_user)):
        edits = payload.get("edits")
        if not isinstance(edits, list) or not edits:
            raise HTTPException(status_code=400, detail="edits 값이 올바르지 않습니다.")

        try:
            df = load_cost_base_df()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        for item in edits:
            row_index = item.get("row_index")
            column = item.get("column")
            value = item.get("value")
            if row_index is None or not isinstance(row_index, int) or row_index < 0:
                continue
            if row_index >= len(df):
                continue
            try:
                col_name = _cost_base_edit_col_name(df, column)
            except ValueError:
                continue
            df.at[row_index, col_name] = "" if value is None else value

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        return {"ok": True}

    @router.post("/returns/cost-base/add-row")
    def returns_cost_base_add_row(payload: dict = Body(...), admin: str = Depends(require_admin)):
        name = str(payload.get("name") or "").strip()
        code = str(payload.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="A열 상품코드는 필수입니다. (상품코드 없는 행은 추가할 수 없습니다)")

        try:
            df = load_cost_base_df().copy()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")

        row_data: dict[str, object] = {}
        row_data[df.columns[COST_BASE_CODE_COL]] = code
        row_data[df.columns[COST_BASE_MATCH_COL]] = name
        for index, col in enumerate(list(df.columns)):
            if index not in (COST_BASE_CODE_COL, COST_BASE_MATCH_COL):
                row_data[col] = ""

        df = pd.concat([df, pd.DataFrame([row_data], columns=list(df.columns))], ignore_index=True)

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        state = get_return_state(admin)
        load_return_cost_base(state)
        return {"ok": True, "status": return_status(state), "row_added": {"name": name, "code": code}}

    @router.post("/returns/cost-base/append-rows")
    def returns_cost_base_append_rows(payload: dict = Body(...), admin: str = Depends(require_admin)):
        text = str(payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="추가할 데이터를 붙여넣으세요.")

        try:
            df = load_cost_base_df().copy()
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"원가베이스 로드 실패: {e}")

        if df.shape[1] < COST_BASE_REQUIRED_COLS:
            raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")

        new_rows = []
        for line in text.splitlines():
            parts = line.split('\t')
            code = parts[0].strip() if parts else ""
            name = parts[1].strip() if len(parts) > 1 else ""
            if not name and not code:
                continue
            row_data: dict[str, object] = {df.columns[COST_BASE_CODE_COL]: code, df.columns[COST_BASE_MATCH_COL]: name}
            for index, col in enumerate(list(df.columns)):
                if index not in (COST_BASE_CODE_COL, COST_BASE_MATCH_COL):
                    row_data[col] = ""
            new_rows.append(row_data)

        if not new_rows:
            raise HTTPException(status_code=400, detail="유효한 행이 없습니다.")

        df = pd.concat([df, pd.DataFrame(new_rows, columns=list(df.columns))], ignore_index=True)

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        state = get_return_state(admin)
        load_return_cost_base(state)
        return {"ok": True, "appended": len(new_rows)}

    @router.post("/returns/scan")
    def returns_scan(payload: dict = Body(...), user: str = Depends(get_current_user)):
        barcode_raw = (payload.get("barcode") or "").strip()
        barcode = clean_invoice(barcode_raw)
        if not barcode:
            raise HTTPException(status_code=400, detail="barcode 값이 비어있음")

        state = get_return_state(user)

        if barcode in state.scanned_barcodes:
            state.last_type = "중복"
            return {
                "ok": True,
                "duplicate": True,
                "last_type": state.last_type,
                "queues": return_queue_payload(state),
            }

        exchange_row_indexes = []
        if getattr(state, "exchange_index", None):
            exchange_row_indexes = state.exchange_index.get(barcode, [])

        if exchange_row_indexes:
            state.last_added_ids = []
            last_types = set()
            for row_i in exchange_row_indexes:
                row = state.exchange_df.iloc[row_i]
                exchange_reason = row.get("EXCHANGE_REASON", "")
                exchange_type = _exchange_type(exchange_reason)
                sound_type = _exchange_sound_type(exchange_type)
                item = {
                    "id": state.next_id,
                    "scan": barcode,
                    "match": barcode,
                    "item_text": row.get("ITEM_TEXT", ""),
                    "qty": row.get("QTY", ""),
                    "type": exchange_type,
                    "reason": exchange_reason,
                    "sound_type": sound_type,
                    "detail_reason": row.get("DETAIL_REASON", ""),
                    "order_sno": _clean_sno(row.get("ORDER_SNO")),
                    "order_item_sno": _clean_sno(row.get("ORDER_ITEM_SNO")),
                    "exchange_option_sno": _clean_sno(row.get("EXCHANGE_OPTION_SNO")),
                    "exchange_sno": _clean_sno(row.get("EXCHANGE_SNO")),
                    "ably_status": _clean_sno(row.get("EXCHANGE_STATUS")),
                    "images": list(row.get("REASON_IMAGES") or []),
                    "goods_name": str(row.get("GOODS_NAME") or ""),
                    "option_raw": str(row.get("OPTION_RAW") or ""),
                }
                state.next_id += 1
                state.last_added_ids.append(item["id"])
                if exchange_type == "교환판매자":
                    state.queue_exchange_seller.append(item)
                else:
                    state.queue_exchange_customer.append(item)
                state.all_items.append(item)
                last_types.add(exchange_type)

            if len(last_types) == 1:
                state.last_type = next(iter(last_types))
            else:
                state.last_type = "혼합(" + ",".join(sorted(last_types)) + ")"
            state.scanned_barcodes.add(barcode)

            # 같은 order_sno의 다른 교환건이 아직 큐에 없으면 (반품이 나눠서
            # 접수됐지만 실제로는 한 박스로 같이 도착한 경우) 알려준다 -
            # 자동으로 추가하지 않고 프론트에서 확인 후 추가하도록 정보만 넘김.
            order_snos = {
                _clean_sno(row_data.get("ORDER_SNO"))
                for row_data in (state.exchange_df.iloc[i].to_dict() for i in exchange_row_indexes)
                if _clean_sno(row_data.get("ORDER_SNO"))
            }
            matched_invoices = {it.get("match") for it in state.all_items if it.get("match")}
            related_unscanned = [
                {**r, "source": "exchange"}
                for r in _find_related_unscanned(state.exchange_df, "ORDER_SNO", order_snos, "T_clean", matched_invoices)
            ]

            return {
                "ok": True,
                "last_type": state.last_type,
                "sound_type": sound_type,
                "queues": return_queue_payload(state),
                "related_unscanned": related_unscanned,
            }

        if not state.map_d_to_e and not state.map_lotte:
            raise HTTPException(status_code=400, detail="먼저 CJ 또는 롯데택배 엑셀을 불러오세요.")
        if state.df2 is None or state.df2_index is None:
            raise HTTPException(status_code=400, detail="먼저 2번 엑셀을 불러오세요.")

        e_val = state.map_d_to_e.get(barcode, "") or state.map_lotte.get(barcode, "")
        if not e_val:
            msg = f"[미매칭] 스캔:{barcode} → CJ(D)/롯데(G)에서 찾지 못함"
            state.queue_unmatched.append(
                {"id": state.next_id, "scan": barcode, "match": "", "item_text": msg, "qty": "", "type": "미매칭"}
            )
            state.next_id += 1
            state.last_type = "미매칭"
            return {"ok": True, "last_type": state.last_type, "queues": return_queue_payload(state)}

        if e_val in {it.get("match") for it in state.all_items if it.get("match")}:
            # /returns/scan-related로 이미 큐에 들어간 건 (related_unscanned
            # 확인 후 추가한 경우) - 물리 바코드는 처음 스캔이라도 실제로는
            # 같은 행이므로 중복 처리한다.
            state.last_type = "중복"
            state.scanned_barcodes.add(barcode)
            return {"ok": True, "duplicate": True, "last_type": state.last_type, "queues": return_queue_payload(state)}

        row_indexes = state.df2_index.get(e_val, [])
        if not row_indexes:
            msg = f"[미매칭] 스캔:{barcode} → 1번(E):{e_val} → 2번(M)에서 찾지 못함"
            state.queue_unmatched.append(
                {"id": state.next_id, "scan": barcode, "match": e_val, "item_text": msg, "qty": "", "type": "미매칭"}
            )
            state.next_id += 1
            state.last_type = "미매칭"
            return {"ok": True, "last_type": state.last_type, "queues": return_queue_payload(state)}

        state.last_added_ids = []
        last_types = set()

        for row_i in row_indexes:
            row = state.df2.iloc[row_i]
            item_text = row.get("ITEM_TEXT", "")
            qty = row.get("QTY", "")
            rtype = row.get("REASON_TYPE", "미매칭")
            if rtype not in ("판매자", "고객"):
                rtype = "미매칭"

            item = {
                "id": state.next_id,
                "scan": barcode,
                "match": e_val,
                "item_text": item_text,
                "qty": qty,
                "type": rtype,
                "detail_reason":  str(row.get("DETAIL_REASON") or ""),
                "user_comment":   str(row.get("USER_COMMENT") or ""),
                "request_no":     str(row.get("REQUEST_NO") or ""),
                "item_sno":       _to_int(row.get("ITEM_SNO")),
                "refund_holder":  str(row.get("REFUND_HOLDER") or ""),
                "refund_account": str(row.get("REFUND_ACCOUNT") or ""),
                "refund_bank_sno": _to_int(row.get("REFUND_BANK_SNO")),
                "buyer_tel":      str(row.get("BUYER_TEL") or ""),
                "order_no":       _clean_sno(row.get("ORDER_NO")),
                "images":         list(row.get("CANCEL_IMAGES") or []),
                "option_code":    str(row.get("OPTION_CODE") or ""),
                "goods_name":     str(row.get("GOODS_NAME") or ""),
                "option_raw":     str(row.get("OPTION_RAW") or ""),
            }
            state.next_id += 1
            state.last_added_ids.append(item["id"])

            if rtype == "판매자":
                state.queue_seller.append(item)
            elif rtype == "고객":
                state.queue_customer.append(item)
            else:
                state.queue_unmatched.append(item)

            state.all_items.append(item)
            last_types.add(rtype)

        if len(last_types) == 1:
            state.last_type = next(iter(last_types))
        else:
            state.last_type = "혼합(" + ",".join(sorted(last_types)) + ")"

        state.scanned_barcodes.add(barcode)

        # 같은 주문번호(ORDER_NO)의 다른 반품건이 아직 큐에 없으면 (반품이
        # 나눠서 접수됐지만 실제로는 한 박스로 같이 도착한 경우) 알려준다.
        order_nos = {
            _clean_sno(row_data.get("ORDER_NO"))
            for row_data in (state.df2.iloc[i].to_dict() for i in row_indexes)
            if _clean_sno(row_data.get("ORDER_NO"))
        }
        matched_invoices = {it.get("match") for it in state.all_items if it.get("match")}
        related_unscanned = [
            {**r, "source": "return"}
            for r in _find_related_unscanned(state.df2, "ORDER_NO", order_nos, "M_clean", matched_invoices)
        ]

        return {
            "ok": True,
            "last_type": state.last_type,
            "queues": return_queue_payload(state),
            "related_unscanned": related_unscanned,
        }

    @router.post("/returns/scan-related")
    def returns_scan_related(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """related_unscanned로 안내된 항목을 실제로 큐에 추가한다.

        일반 반품(source=return)의 invoice는 에이블리 M_clean 값이라 CJ/롯데
        물리송장 → E값 매핑을 거치는 /returns/scan으로는 못 찾는다 (그 매핑은
        반대 방향으로만 존재함) - 그래서 exchange_df/df2에서 직접 행을 찾아
        큐에 넣는 별도 경로가 필요하다.
        """
        source = str(payload.get("source") or "").strip()
        invoice = clean_invoice(str(payload.get("invoice") or ""))
        if not invoice:
            raise HTTPException(status_code=400, detail="invoice 값이 비어있음")

        state = get_return_state(user)
        matched_invoices = {it.get("match") for it in state.all_items if it.get("match")}
        if invoice in matched_invoices:
            return {"ok": True, "duplicate": True, "queues": return_queue_payload(state)}

        if source == "exchange":
            row_indexes = (getattr(state, "exchange_index", None) or {}).get(invoice, [])
            if not row_indexes:
                raise HTTPException(status_code=404, detail="해당 교환건을 찾을 수 없습니다.")
            state.last_added_ids = []
            last_types = set()
            for row_i in row_indexes:
                row = state.exchange_df.iloc[row_i]
                exchange_reason = row.get("EXCHANGE_REASON", "")
                exchange_type = _exchange_type(exchange_reason)
                item = {
                    "id": state.next_id,
                    "scan": invoice,
                    "match": invoice,
                    "item_text": row.get("ITEM_TEXT", ""),
                    "qty": row.get("QTY", ""),
                    "type": exchange_type,
                    "reason": exchange_reason,
                    "sound_type": _exchange_sound_type(exchange_type),
                    "detail_reason": row.get("DETAIL_REASON", ""),
                    "order_sno": _clean_sno(row.get("ORDER_SNO")),
                    "order_item_sno": _clean_sno(row.get("ORDER_ITEM_SNO")),
                    "exchange_option_sno": _clean_sno(row.get("EXCHANGE_OPTION_SNO")),
                    "exchange_sno": _clean_sno(row.get("EXCHANGE_SNO")),
                    "ably_status": _clean_sno(row.get("EXCHANGE_STATUS")),
                    "images": list(row.get("REASON_IMAGES") or []),
                    "goods_name": str(row.get("GOODS_NAME") or ""),
                    "option_raw": str(row.get("OPTION_RAW") or ""),
                }
                state.next_id += 1
                state.last_added_ids.append(item["id"])
                if exchange_type == "교환판매자":
                    state.queue_exchange_seller.append(item)
                else:
                    state.queue_exchange_customer.append(item)
                state.all_items.append(item)
                last_types.add(exchange_type)
            state.last_type = next(iter(last_types)) if len(last_types) == 1 else "혼합(" + ",".join(sorted(last_types)) + ")"
            state.scanned_barcodes.add(invoice)

        elif source == "return":
            row_indexes = (getattr(state, "df2_index", None) or {}).get(invoice, [])
            if not row_indexes:
                raise HTTPException(status_code=404, detail="해당 반품건을 찾을 수 없습니다.")
            state.last_added_ids = []
            last_types = set()
            for row_i in row_indexes:
                row = state.df2.iloc[row_i]
                rtype = row.get("REASON_TYPE", "미매칭")
                if rtype not in ("판매자", "고객"):
                    rtype = "미매칭"
                item = {
                    "id": state.next_id,
                    "scan": invoice,
                    "match": invoice,
                    "item_text": row.get("ITEM_TEXT", ""),
                    "qty": row.get("QTY", ""),
                    "type": rtype,
                    "detail_reason":  str(row.get("DETAIL_REASON") or ""),
                    "user_comment":   str(row.get("USER_COMMENT") or ""),
                    "request_no":     str(row.get("REQUEST_NO") or ""),
                    "item_sno":       _to_int(row.get("ITEM_SNO")),
                    "refund_holder":  str(row.get("REFUND_HOLDER") or ""),
                    "refund_account": str(row.get("REFUND_ACCOUNT") or ""),
                    "refund_bank_sno": _to_int(row.get("REFUND_BANK_SNO")),
                    "order_no":       _clean_sno(row.get("ORDER_NO")),
                    "images":         list(row.get("CANCEL_IMAGES") or []),
                    "option_code":    str(row.get("OPTION_CODE") or ""),
                    "goods_name":     str(row.get("GOODS_NAME") or ""),
                    "option_raw":     str(row.get("OPTION_RAW") or ""),
                }
                state.next_id += 1
                state.last_added_ids.append(item["id"])
                if rtype == "판매자":
                    state.queue_seller.append(item)
                elif rtype == "고객":
                    state.queue_customer.append(item)
                else:
                    state.queue_unmatched.append(item)
                state.all_items.append(item)
                last_types.add(rtype)
            state.last_type = next(iter(last_types)) if len(last_types) == 1 else "혼합(" + ",".join(sorted(last_types)) + ")"
            state.scanned_barcodes.add(invoice)

        else:
            raise HTTPException(status_code=400, detail="source 값이 올바르지 않습니다 (exchange 또는 return).")

        return {"ok": True, "last_type": state.last_type, "queues": return_queue_payload(state)}

    @router.post("/returns/undo")
    def returns_undo(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if not state.last_added_ids:
            raise HTTPException(status_code=400, detail="삭제할 최근 스캔 기록이 없습니다.")

        remove_ids = set(state.last_added_ids)
        _remove_return_queue_ids(state, remove_ids)
        state.last_added_ids = []
        state.last_type = "-"
        return {"ok": True, "queues": return_queue_payload(state), "last_type": state.last_type}

    @router.post("/returns/reset")
    def returns_reset(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        state.queue_seller.clear()
        state.queue_customer.clear()
        state.queue_unmatched.clear()
        state.queue_exchange.clear()
        state.queue_exchange_seller.clear()
        state.queue_exchange_customer.clear()
        state.all_items.clear()
        state.last_added_ids.clear()
        state.scanned_barcodes.clear()
        state.customer_export_df = pd.DataFrame()
        state.last_type = "-"
        return {"ok": True}

    @router.post("/returns/onebe/reset")
    def returns_onebe_reset(user: str = Depends(get_current_user)):
        """원베양식(고객대기) 데이터만 초기화한다 - 판매자/고객/미매칭 대기 큐는 건드리지 않는다."""
        state = get_return_state(user)
        state.customer_export_df = pd.DataFrame()
        return {"ok": True, "onebe": {"rows": return_rows(state.customer_export_df)}}

    @router.post("/returns/delete-items")
    def returns_delete_items(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        raw_ids = payload.get("ids") or []
        remove_ids = {int(i) for i in raw_ids}
        if not remove_ids:
            raise HTTPException(status_code=400, detail="삭제할 항목이 없습니다.")
        _remove_return_queue_ids(state, remove_ids)
        return {"ok": True, "queues": return_queue_payload(state)}

    @router.post("/returns/unmatched/lookup-cs")
    async def returns_unmatched_lookup_cs(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """미매칭 항목의 원송장번호로 이지어드민에서 구매자 전화번호와 상품코드를 찾고,
        그 전화번호로 에이블리 CS문의(진행중+완료)가 있는지 확인한다.

        이지어드민 CS 화면에서 송장번호로 검색해 전화번호를 확인한 뒤,
        그 번호로 에이블리 CS창에서 다시 검색하던 수작업을 대체한다. 같은
        검색(query_json)으로 얻은 pack을 그대로 packlist_json에 넘겨 상품코드도
        같이 확보해둔다 - 나중에 "입고처리" 버튼이 재검색 없이 바로 쓴다.

        이지어드민 E900 검색은 반품송장(스캔값)이 아니라 원송장번호로 해야
        한다 - item["match"]가 반품송장→원송장 매핑(map_d_to_e/map_lotte)을
        거친 e_val이고, item["scan"]은 고객이 반품 보낼 때 붙인 반품송장이라
        이지어드민에 없다 (반품송장 → LOGIS 원송장조회 → CS검색 순서를
        그대로 반영한 것).
        """
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        raw_ids = payload.get("ids") or []
        target_ids = {int(i) for i in raw_ids}
        if not target_ids:
            raise HTTPException(status_code=400, detail="조회할 항목이 없습니다.")

        items = [it for it in state.queue_unmatched if it.get("id") in target_ids]
        if not items:
            return {"ok": True, "checked": 0, "queues": return_queue_payload(state)}

        ez = EzAdminClient(get_setting)
        ably = AblyClient()

        now = datetime.now(_KST)
        start_date = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        checked = 0
        for item in items:
            original_invoice = str(item.get("match") or "").strip()
            if not original_invoice:
                item["cs_error"] = "원송장번호 없음 (반품송장 매핑 실패)"
                item["cs_products"] = []
                item["cs_product_error"] = "원송장번호 없음"
                checked += 1
                continue
            try:
                order = await ez.find_order_by_invoice(original_invoice, start_date=start_date, end_date=end_date)
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "checked": checked, "queues": return_queue_payload(state)}

            if not order:
                item["cs_phone"] = ""
                item["cs_ably_exists"] = None
                item["cs_error"] = "이지어드민 미조회"
                item["cs_products"] = []
                item["cs_product_error"] = "이지어드민 미조회"
                checked += 1
                continue

            phone = order.get("phone")
            item["cs_phone"] = phone or ""
            item.pop("cs_error", None)

            try:
                line_items = await ez.packlist_items(order["pack"])
                product_qty: dict[str, float] = {}
                for line in line_items:
                    code = str(line.get("product_id") or "").strip()
                    if not code:
                        continue
                    try:
                        qty = float(line.get("qty") or 0)
                    except (TypeError, ValueError):
                        qty = 0
                    product_qty[code] = product_qty.get(code, 0) + qty
                info_map = _wonbe_product_info(list(product_qty.keys()))
                item["cs_products"] = [
                    {
                        "product_id": code,
                        "qty": qty,
                        "name": info_map.get(code, {}).get("상품명", ""),
                        "color": info_map.get(code, {}).get("색상", ""),
                        "size": info_map.get(code, {}).get("사이즈", ""),
                    }
                    for code, qty in product_qty.items()
                ]
                if item["cs_products"]:
                    item.pop("cs_product_error", None)
                else:
                    item["cs_product_error"] = "패킹리스트에 상품코드 없음"
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "checked": checked, "queues": return_queue_payload(state)}
            except Exception as e:
                item["cs_products"] = []
                item["cs_product_error"] = f"상품코드 조회 실패: {str(e)[:200]}"

            if phone:
                try:
                    count = await ably.count_contact_rooms_by_mobile(phone, start_date=start_date, end_date=end_date)
                    item["cs_ably_exists"] = count > 0
                except Exception as e:
                    item["cs_ably_exists"] = None
                    item["cs_error"] = f"에이블리 조회 실패: {str(e)[:200]}"
            else:
                item["cs_ably_exists"] = None
            checked += 1

        return {"ok": True, "checked": checked, "queues": return_queue_payload(state)}

    @router.post("/returns/unmatched/receive-stock")
    async def returns_unmatched_receive_stock(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """미매칭 항목을 이지어드민 입고처리(I100)한다.

        상품코드는 /returns/unmatched/lookup-cs가 원송장번호로 이미 조회해둔
        item["cs_products"]를 그대로 쓴다 (재검색 없음) - 먼저 CS 조회를
        실행해야 한다. 메모는 "반품입고 <원송장번호>"로 남긴다. 원송장번호는
        item["match"](반품송장→원송장 매핑을 거친 e_val)이며, item["scan"]
        (고객이 반품 보낼 때 붙인 반품송장)이 아니다.
        """
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        raw_ids = payload.get("ids") or []
        target_ids = {int(i) for i in raw_ids}
        if not target_ids:
            raise HTTPException(status_code=400, detail="처리할 항목이 없습니다.")

        items = [it for it in state.queue_unmatched if it.get("id") in target_ids]
        if not items:
            return {"ok": True, "results": [], "queues": return_queue_payload(state)}

        ez = EzAdminClient(get_setting)
        results = []
        for item in items:
            original_invoice = str(item.get("match") or "").strip()
            products = item.get("cs_products") or []
            result = {"id": item.get("id"), "ok": False, "error": None}
            if not original_invoice:
                result["error"] = "원송장번호 없음"
                item["ezadmin_stockin_error"] = result["error"]
                results.append(result)
                continue
            if not products:
                result["error"] = "상품코드 없음 (먼저 CS 조회를 실행하세요)"
                item["ezadmin_stockin_error"] = result["error"]
                results.append(result)
                continue

            memo = f"반품입고 {original_invoice}"
            done_codes = []
            try:
                for product in products:
                    product_id = str(product.get("product_id") or "").strip()
                    if not product_id:
                        continue
                    qty = product.get("qty") or 1
                    try:
                        qty = int(float(qty)) or 1
                    except (TypeError, ValueError):
                        qty = 1
                    await ez.receive_stock(product_id, qty, memo=memo)
                    done_codes.append(product_id)
                result["ok"] = True
                result["product_ids"] = done_codes
                item["ezadmin_stockin_done"] = True
                item["ezadmin_stockin_product_id"] = ", ".join(done_codes)
                item.pop("ezadmin_stockin_error", None)
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "results": results, "queues": return_queue_payload(state)}
            except Exception as e:
                result["error"] = str(e)[:200]
                item["ezadmin_stockin_error"] = result["error"]
            results.append(result)

        return {"ok": True, "results": results, "queues": return_queue_payload(state)}

    @router.post("/returns/unmatched/cs-detail")
    async def returns_unmatched_cs_detail(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """전화번호로 에이블리 CS문의방 목록을 찾아 각 방의 전체 대화 내용을 가져온다.

        lookup-cs로 "있음"이 확인된 뒤, 실제 내용을 확인하고 싶을 때 클릭 시점에
        불러온다 (일괄조회 단계에서는 개수만 확인하고 내용은 조회하지 않음).
        """
        phone = str(payload.get("phone") or "").strip()
        if not phone:
            raise HTTPException(status_code=400, detail="전화번호가 필요합니다.")

        ably = AblyClient()
        now = datetime.now(_KST)
        start_date = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        try:
            rooms = await ably.list_contact_rooms_by_mobile(phone, start_date=start_date, end_date=end_date)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"에이블리 CS 목록 조회 실패: {str(e)[:200]}")

        result_rooms = []
        for room in rooms[:5]:
            sno = room.get("sno")
            if not sno:
                continue
            try:
                detail = await ably.get_contact_room_messages(sno)
            except Exception as e:
                detail = {
                    "status_display": room.get("get_status_display"),
                    "market_name": (room.get("market") or {}).get("name"),
                    "messages": [],
                    "error": f"대화 내용 조회 실패: {str(e)[:200]}",
                }
            result_rooms.append(detail)

        return {"ok": True, "rooms": result_rooms}

    @router.post("/returns/onebe/build")
    def returns_build_onebe(payload: dict = Body(None), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        source = (payload or {}).get("source", "customer")
        if source == "all":
            items = state.all_items
            if not items:
                raise HTTPException(status_code=400, detail="전체 대기 데이터가 없습니다.")
        else:
            exchange_normal_items = [
                item for item in state.queue_exchange_customer if item.get("sound_type") == "교환정상"
            ]
            items = list(state.queue_customer) + exchange_normal_items
            if not items:
                raise HTTPException(status_code=400, detail="고객 대기 또는 교환정상 데이터가 없습니다.")

        if not state.cost_map:
            try:
                load_return_cost_base(state)
            except Exception:
                raise HTTPException(status_code=400, detail="원가베이스를 먼저 불러오세요.")

        rows = []
        for it in items:
            item_text = normalize_spaces(it.get("item_text", ""))
            match_key = normalize_key(item_text)
            product_code = state.cost_map.get(match_key, "")
            matched_flag = "O" if product_code else "X"

            rows.append(
                {
                    "상품코드": product_code,
                    "요청수량": 0,
                    "수량": it.get("qty", ""),
                    "가공데이터": item_text,
                    "스캔송장": it.get("scan", ""),
                    "매칭송장": _request_memo_for_item(state, it),
                    "분류": it.get("type", "고객"),
                    "원가베이스매칭": matched_flag,
                }
            )

        state.customer_export_df = pd.DataFrame(rows)
        return {"ok": True, "onebe": {"rows": return_rows(state.customer_export_df)}}

    @router.post("/returns/onebe/consolidate")
    def returns_consolidate_onebe(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if state.customer_export_df is None or state.customer_export_df.empty:
            raise HTTPException(status_code=400, detail="먼저 '고객대기 → 원베양식 생성'을 실행하세요.")

        df = state.customer_export_df.copy()
        has_code = df["상품코드"].fillna("").astype(str).str.strip() != ""
        df_code = df[has_code].copy()
        df_empty = df[~has_code].copy()

        def to_int_safe(x):
            if x is None:
                return 0
            s = str(x).strip()
            if s == "" or s.lower() in ("nan", "none"):
                return 0
            try:
                return int(float(s))
            except Exception:
                return 0

        df_code["_qty_int"] = df_code["수량"].apply(to_int_safe)

        def merge_match_invoices(series):
            seen = set()
            out = []
            for v in series.fillna("").astype(str).tolist():
                v = v.strip()
                if not v or v.lower() in ("nan", "none"):
                    continue
                parts = [p.strip() for p in v.split(",") if p.strip()]
                for p in parts:
                    if p not in seen:
                        seen.add(p)
                        out.append(p)
            return ",".join(out)

        agg = (
            df_code.groupby("상품코드", as_index=False)
            .agg(
                {
                    "요청수량": "first",
                    "_qty_int": "sum",
                    "가공데이터": "first",
                    "스캔송장": "first",
                    "매칭송장": merge_match_invoices,
                    "분류": "first",
                    "원가베이스매칭": "first",
                }
            )
        )

        agg["입고수량"] = agg["_qty_int"].astype(int)
        agg.drop(columns=["_qty_int"], inplace=True)
        agg.rename(columns={"매칭송장": "요청메모"}, inplace=True)

        new_df = pd.concat([agg, df_empty], ignore_index=True)
        state.customer_export_df = new_df
        return {"ok": True, "onebe": {"rows": return_rows(state.customer_export_df)}}

    @router.post("/returns/onebe/edit")
    def returns_edit_onebe(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if state.customer_export_df is None or state.customer_export_df.empty:
            raise HTTPException(status_code=400, detail="원베양식 데이터가 없습니다.")

        row_index = payload.get("row_index")
        column = (payload.get("column") or "").strip()
        value = (payload.get("value") or "").strip()

        if row_index is None or not isinstance(row_index, int):
            raise HTTPException(status_code=400, detail="row_index가 필요합니다.")
        if column not in state.customer_export_df.columns:
            raise HTTPException(status_code=400, detail="유효하지 않은 컬럼입니다.")
        if row_index < 0 or row_index >= len(state.customer_export_df):
            raise HTTPException(status_code=400, detail="유효하지 않은 행입니다.")

        if column in ("요청수량", "수량"):
            if value == "":
                value = "0"
            try:
                value = str(int(float(value)))
            except Exception:
                raise HTTPException(status_code=400, detail="수량은 숫자여야 합니다.")

        state.customer_export_df.at[row_index, column] = value
        return {"ok": True}

    @router.post("/returns/onebe/create-ezadmin-sheet")
    async def returns_create_onebe_ezadmin_sheet(user: str = Depends(get_current_user)):
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        upload_xls, upload_count = _build_onebe_im25_xls_bytes(state.customer_export_df)

        now = datetime.now(_KST)
        start_date = now.strftime("%Y-%m-%d")
        sheet_title = "반품 바코드"
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": f"{_EZADMIN_BASE}/template40.htm?template=IM00",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        payload = {
            "template": "IM00",
            "action": "new_sheet_each",
            "start_date": start_date,
            "sheet_title": sheet_title,
            "timeFlag": _browser_time_flag(now),
        }

        try:
            async with httpx.AsyncClient(timeout=30.0, verify=False, follow_redirects=True) as client:
                response = await client.post(
                    f"{_EZADMIN_BASE}/function.htm",
                    data=payload,
                    cookies={"PHPSESSID": phpsessid},
                    headers=headers,
                )
                body = (response.text or "").strip()
                if _looks_like_ezadmin_session_error(response, body):
                    return {"ok": False, "need_session": True}
                if not (200 <= response.status_code < 300):
                    return {
                        "ok": False,
                        "need_session": False,
                        "detail": f"EZAdmin 전표 생성 실패 (HTTP {response.status_code})",
                    }
                if body:
                    return {
                        "ok": False,
                        "need_session": False,
                        "detail": f"EZAdmin 전표 생성 응답을 확인할 수 없습니다: {body[:300]}",
                    }

                sheet_seq = None
                for _ in range(5):
                    await asyncio.sleep(0.5)
                    sheet_seq = await _find_ezadmin_sheet_seq(
                        client,
                        phpsessid=phpsessid,
                        start_date=start_date,
                        sheet_title=sheet_title,
                    )
                    if sheet_seq:
                        break
                if not sheet_seq:
                    return {
                        "ok": False,
                        "need_session": False,
                        "detail": "전표는 생성됐지만 전표번호를 찾지 못해 상품 일괄추가를 진행하지 못했습니다.",
                    }

                upload_response = await client.post(
                    f"{_EZADMIN_BASE}/popup_utf8.htm",
                    data={"template": "IM25", "action": "upload", "seq": sheet_seq},
                    files={
                        "_file": (
                            "returns_onebe_products.xls",
                            upload_xls,
                            "application/vnd.ms-excel",
                        )
                    },
                    cookies={"PHPSESSID": phpsessid},
                    headers={
                        "User-Agent": "Mozilla/5.0",
                        "Referer": f"{_EZADMIN_BASE}/popup35.htm?template=IM25&seq={sheet_seq}",
                    },
                )
        except httpx.HTTPError as exc:
            return {"ok": False, "need_session": False, "detail": f"EZAdmin 요청 실패: {exc}"}

        upload_body = (upload_response.text or "").strip()
        if _looks_like_ezadmin_login_page(upload_response, upload_body):
            return {"ok": False, "need_session": True}

        if not (200 <= upload_response.status_code < 300):
            return {
                "ok": False,
                "need_session": False,
                "detail": f"상품 일괄추가 실패 (HTTP {upload_response.status_code})",
            }

        return {
            "ok": True,
            "sheet_title": sheet_title,
            "start_date": start_date,
            "sheet_seq": sheet_seq,
            "uploaded_count": upload_count,
        }

    @router.post("/returns/onebe/barcode-print")
    async def returns_onebe_barcode_print(payload: dict = Body(...), user=Depends(get_current_user)):
        sheet_seq = str(payload.get("sheet_seq") or "").strip()
        products = payload.get("products") or []
        if not sheet_seq:
            return {"ok": False, "error": "sheet_seq가 필요합니다"}

        phpsessid = get_setting(_EZADMIN_SESSION_KEY)
        if not phpsessid:
            return {"ok": False, "need_session": True}

        cookies = {"PHPSESSID": phpsessid}
        ezadmin_base = _EZADMIN_BASE

        arr_product_id = [str(p.get("code") or "") for p in products]
        arr_product_name = [str(p.get("name") or "") for p in products]
        arr_product_option = [str(p.get("option") or "") for p in products]
        arr_qty = [str(int(p.get("qty") or 1)) for p in products]

        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            try:
                init_res = await client.get(
                    f"{ezadmin_base}/popup35.htm",
                    params={"template": "S500", "sheet_type": "sheet_req", "sheet": sheet_seq},
                    cookies=cookies,
                )
            except httpx.HTTPError as exc:
                return {"ok": False, "error": f"S500 초기화 실패: {exc}"}

            init_body = (init_res.text or "").strip()
            if _looks_like_ezadmin_login_page(init_res, init_body):
                return {"ok": False, "need_session": True}

            try:
                make_res = await client.post(
                    f"{ezadmin_base}/function.htm",
                    data={
                        "template": "S500",
                        "action": "make_html2",
                        "barcode_template": "10009",
                        "formtec_start_num": "",
                        "sheet": sheet_seq,
                        "arr_product_id": json.dumps(arr_product_id, ensure_ascii=False),
                        "arr_product_name": json.dumps(arr_product_name, ensure_ascii=False),
                        "arr_product_option": json.dumps(arr_product_option, ensure_ascii=False),
                        "arr_qty": json.dumps(arr_qty, ensure_ascii=False),
                        "readonly": "T",
                    },
                    cookies=cookies,
                    headers={
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": f"{ezadmin_base}/popup35.htm?template=S500&sheet_type=sheet_req&sheet={sheet_seq}",
                    },
                )
            except httpx.HTTPError as exc:
                return {"ok": False, "error": f"make_html2 요청 실패: {exc}"}

            make_body = (make_res.text or "").strip()
            if _looks_like_ezadmin_login_page(make_res, make_body):
                return {"ok": False, "need_session": True}

            html_paths = re.findall(r"/data/yusaek/[^\"'<\s]+", make_body)
            if not html_paths:
                return {"ok": False, "error": "HTML 경로 추출 실패", "_body": make_body[:300]}

            html_path = html_paths[0]
            try:
                html_res = await client.get(
                    f"{ezadmin_base}{html_path}",
                    cookies=cookies,
                )
            except httpx.HTTPError as exc:
                return {"ok": False, "error": f"HTML 파일 조회 실패: {exc}"}

            return {"ok": True, "html": html_res.text}

    @router.post("/returns/download/onebe")
    def returns_download_onebe(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if state.customer_export_df is None or state.customer_export_df.empty:
            raise HTTPException(status_code=400, detail="원베양식 데이터가 없습니다.")

        columns = payload.get("columns") or []
        if not isinstance(columns, list) or not columns:
            columns = ["상품코드", "요청수량", "수량"]

        for c in columns:
            if c not in state.customer_export_df.columns:
                raise HTTPException(status_code=400, detail=f"유효하지 않은 컬럼: {c}")

        fmt = (payload.get("format") or "xlsx").lower().strip()
        if fmt not in ("xlsx", "xls"):
            fmt = "xlsx"

        header_map = payload.get("header_map") or {}
        if not isinstance(header_map, dict):
            header_map = {}

        out = state.customer_export_df.loc[:, columns].copy()
        rename_map = {}
        for c in columns:
            val = header_map.get(c)
            if isinstance(val, str) and val.strip():
                rename_map[c] = val.strip()
        if rename_map:
            out.rename(columns=rename_map, inplace=True)
        buf = io.BytesIO()
        if fmt == "xlsx":
            with pd.ExcelWriter(buf, engine="openpyxl") as writer:
                out.to_excel(writer, index=False, sheet_name="원베양식")
            filename = "원베_고객대기_추출.xlsx"
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            content = _build_xls_bytes_from_sheets([("원베양식", out)])
            filename = "원베_고객대기_추출.xls"
            media_type = "application/vnd.ms-excel"
            headers = {"Content-Disposition": content_disposition(filename)}
            return Response(content=content, media_type=media_type, headers=headers)
        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=buf.getvalue(), media_type=media_type, headers=headers)

    @router.post("/returns/download/queues")
    def returns_download_queues(payload: dict = Body(...), user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if (
            (not state.queue_seller)
            and (not state.queue_customer)
            and (not state.queue_unmatched)
            and (not state.queue_exchange)
            and (not state.queue_exchange_seller)
            and (not state.queue_exchange_customer)
        ):
            raise HTTPException(status_code=400, detail="추출할 대기 데이터가 없습니다.")

        fmt = (payload.get("format") or "xlsx").lower().strip()
        if fmt not in ("xlsx", "xls"):
            fmt = "xlsx"

        def with_resolved_request_memo(items: list[dict]) -> list[dict]:
            resolved = []
            for item in items:
                next_item = dict(item)
                next_item["match"] = _request_memo_for_item(state, next_item)
                resolved.append(next_item)
            return resolved

        df_seller = pd.DataFrame(state.queue_seller)
        df_customer = pd.DataFrame(state.queue_customer)
        df_unmatched = pd.DataFrame(state.queue_unmatched)
        df_exchange_seller = pd.DataFrame(with_resolved_request_memo(state.queue_exchange_seller))
        df_exchange_customer = pd.DataFrame(
            with_resolved_request_memo(list(state.queue_exchange_customer) + list(state.queue_exchange))
        )

        for dfx in (df_seller, df_customer, df_unmatched, df_exchange_seller, df_exchange_customer):
            if not dfx.empty:
                dfx.drop(columns=["id"], inplace=True, errors="ignore")
                dfx.rename(
                    columns={
                        "scan": "스캔송장",
                        "match": "요청메모",
                        "item_text": "가공데이터",
                        "qty": "입고수량",
                        "type": "분류",
                        "reason": "사유",
                        "detail_reason": "상세사유",
                        "user_comment": "고객메모",
                        "request_no": "반품요청번호",
                    },
                    inplace=True,
                )

        buf = io.BytesIO()
        if fmt == "xlsx":
            with pd.ExcelWriter(buf, engine="openpyxl") as writer:
                df_seller.to_excel(writer, index=False, sheet_name="판매자")
                df_customer.to_excel(writer, index=False, sheet_name="고객")
                df_unmatched.to_excel(writer, index=False, sheet_name="미매칭")
                df_exchange_seller.to_excel(writer, index=False, sheet_name="교환판매자")
                df_exchange_customer.to_excel(writer, index=False, sheet_name="교환고객")
            filename = "반품대기_추출.xlsx"
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            content = _build_xls_bytes_from_sheets(
                [
                    ("판매자", df_seller),
                    ("고객", df_customer),
                    ("미매칭", df_unmatched),
                    ("교환판매자", df_exchange_seller),
                    ("교환고객", df_exchange_customer),
                ]
            )
            filename = "반품대기_추출.xls"
            media_type = "application/vnd.ms-excel"
            headers = {"Content-Disposition": content_disposition(filename)}
            return Response(content=content, media_type=media_type, headers=headers)

        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=buf.getvalue(), media_type=media_type, headers=headers)

    @router.post("/returns/ably-refund-from-excel")
    async def returns_ably_refund_from_excel(
        file: UploadFile = File(...),
        user: str = Depends(get_current_user),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        tmp_path = Path(tempfile.gettempdir()) / f"refund_excel_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            xl = pd.ExcelFile(tmp_path)
            sheet_name = "고객" if "고객" in xl.sheet_names else xl.sheet_names[1] if len(xl.sheet_names) > 1 else xl.sheet_names[0]
            df = xl.parse(sheet_name)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"엑셀 읽기 실패: {e}")
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        col = list(df.columns)
        def get_col(names):
            for n in names:
                if n in col:
                    return n
            return None

        cancel_col  = get_col(["반품요청번호", "request_no"])
        item_col    = get_col(["item_sno"])
        holder_col  = get_col(["refund_holder"])
        account_col = get_col(["refund_account"])
        bank_col    = get_col(["refund_bank_sno"])

        if not cancel_col:
            raise HTTPException(status_code=400, detail="'반품요청번호' 열을 찾을 수 없습니다. 올바른 추출 파일인지 확인하세요.")

        rows = []
        for _, row in df.iterrows():
            cancel_sno = str(row.get(cancel_col) or "").strip()
            if not cancel_sno or cancel_sno.lower() in ("nan", "none", ""):
                continue
            try:
                cancel_sno_int = int(float(cancel_sno))
            except (ValueError, TypeError):
                continue
            item_sno_val = None
            if item_col:
                try:
                    item_sno_val = int(float(row.get(item_col) or 0)) or None
                except (ValueError, TypeError):
                    pass
            rows.append({
                "cancel_sno": cancel_sno_int,
                "item_sno": item_sno_val,
                "refund_holder":  str(row.get(holder_col) or "") if holder_col else "",
                "refund_account": str(row.get(account_col) or "") if account_col else "",
                "refund_bank_sno": (lambda v: int(float(v)) if v and str(v).lower() not in ("nan","none","") else None)(row.get(bank_col) if bank_col else None),
            })

        if not rows:
            raise HTTPException(status_code=400, detail="처리할 반품 항목이 없습니다.")

        token = await _ably_login()
        hdrs = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        results = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            for row in rows:
                result = {"cancel_sno": row["cancel_sno"], "ok": False, "error": None}
                try:
                    if not row["item_sno"]:
                        raise ValueError("item_sno 없음 — 반품 API 불러오기 후 추출한 파일이 아닙니다.")

                    r1 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={"data_list": [{"sno_list": [row["cancel_sno"]], "update_list": [
                            {"field": "refund_bank_account_holder", "value": row["refund_holder"]},
                            {"field": "refund_bank_account_number", "value": row["refund_account"]},
                            {"field": "refund_bank_sno", "value": row["refund_bank_sno"]},
                        ]}]},
                    )
                    r1.raise_for_status()

                    r2 = await client.put(
                        f"{ABLY_BASE}/seller/order_items/request_confirm/",
                        headers=hdrs,
                        json={"sno_list": [row["item_sno"]]},
                    )
                    r2.raise_for_status()
                    result["ok"] = True
                    result["item_sno"] = row["item_sno"]
                except Exception as e:
                    result["error"] = str(e)
                results.append(result)

        ok_count = sum(1 for r in results if r["ok"])
        return {"ok": True, "total": len(results), "success": ok_count, "results": results}

    @router.post("/returns/ably-refund-submit")
    async def returns_ably_refund_submit(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        # 테이블에 완료 표시를 남기기 위해, 요청으로 넘어온 항목(사본)이 아니라
        # 서버가 들고 있는 실제 큐 항목을 id로 찾아 그 자리에서 상태를 갱신한다.
        state = get_return_state(user)
        by_id = {it.get("id"): it for it in state.queue_seller}
        by_id.update({it.get("id"): it for it in state.queue_customer})

        token = await _ably_login()
        hdrs = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        results = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            for item in items:
                result = {"id": item.get("id"), "scan": item.get("scan"), "ok": False, "error": None}
                state_item = by_id.get(item.get("id"))
                try:
                    cancel_sno = int(item.get("request_no") or 0)
                    item_sno   = int(item.get("item_sno") or 0)
                    if not cancel_sno or not item_sno:
                        raise ValueError("cancel_sno 또는 item_sno 없음")

                    r1 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={
                            "data_list": [{
                                "sno_list": [cancel_sno],
                                "update_list": [
                                    {"field": "refund_bank_account_holder", "value": item.get("refund_holder", "")},
                                    {"field": "refund_bank_account_number", "value": item.get("refund_account", "")},
                                    {"field": "refund_bank_sno", "value": item.get("refund_bank_sno")},
                                ],
                            }]
                        },
                    )
                    r1.raise_for_status()

                    r2 = await client.put(
                        f"{ABLY_BASE}/seller/order_items/request_confirm/",
                        headers=hdrs,
                        json={"sno_list": [item_sno]},
                    )
                    r2.raise_for_status()
                    result["ok"] = True
                    if state_item is not None:
                        state_item["ably_refund_done"] = True
                        state_item.pop("ably_refund_error", None)
                except Exception as e:
                    result["error"] = str(e)
                    if state_item is not None:
                        state_item["ably_refund_error"] = str(e)[:200]
                results.append(result)

        return {"results": results, "queues": return_queue_payload(state)}

    @router.post("/returns/ably-change-reason-submit")
    async def returns_ably_change_reason_submit(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        """선택된 반품 건의 사유를 일반사유(코드 31)로 변경한 뒤, 기존 환불 요청과
        동일하게 환불계좌를 재저장하고 환불을 확정한다 (HAR로 캡처한 3단계 순서 재현).
        """
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        state = get_return_state(user)
        by_id = {it.get("id"): it for it in state.queue_seller}
        by_id.update({it.get("id"): it for it in state.queue_customer})

        token = await _ably_login()
        hdrs = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        results = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            for item in items:
                result = {"id": item.get("id"), "scan": item.get("scan"), "ok": False, "error": None}
                state_item = by_id.get(item.get("id"))
                try:
                    cancel_sno = int(item.get("request_no") or 0)
                    item_sno   = int(item.get("item_sno") or 0)
                    if not cancel_sno or not item_sno:
                        raise ValueError("cancel_sno 또는 item_sno 없음")

                    r0 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={
                            "data_list": [{
                                "sno_list": [cancel_sno],
                                "update_list": [{"field": "cancel_reason", "value": 31}],
                            }]
                        },
                    )
                    r0.raise_for_status()

                    r1 = await client.put(
                        f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                        headers=hdrs,
                        json={
                            "data_list": [{
                                "sno_list": [cancel_sno],
                                "update_list": [
                                    {"field": "refund_bank_account_holder", "value": item.get("refund_holder", "")},
                                    {"field": "refund_bank_account_number", "value": item.get("refund_account", "")},
                                    {"field": "refund_bank_sno", "value": item.get("refund_bank_sno")},
                                ],
                            }]
                        },
                    )
                    r1.raise_for_status()

                    r2 = await client.put(
                        f"{ABLY_BASE}/seller/order_items/request_confirm/",
                        headers=hdrs,
                        json={"sno_list": [item_sno]},
                    )
                    r2.raise_for_status()
                    result["ok"] = True
                    if state_item is not None:
                        state_item["ably_reason_changed"] = True
                        state_item.pop("ably_reason_change_error", None)
                except Exception as e:
                    result["error"] = str(e)
                    if state_item is not None:
                        state_item["ably_reason_change_error"] = str(e)[:200]
                results.append(result)

        return {"results": results, "queues": return_queue_payload(state)}

    @router.post("/returns/ezadmin-receive-stock")
    async def returns_ezadmin_receive_stock(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        """선택된 반품/교환 항목을 이지어드민 입고처리(I100)한다.

        반품 항목은 item.option_code(에이블리 option_stock_sync_code), 교환 항목은
        item.exchange_option_sno를 원가베이스유의 옵션번호와 매칭해 상품코드를
        찾고, 그 상품코드로 입고처리한다.
        """
        items = payload.get("items", [])
        if not items:
            raise HTTPException(status_code=400, detail="선택된 항목이 없습니다.")

        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return {"ok": False, "need_session": True}

        state = get_return_state(user)
        by_id = {it.get("id"): it for it in state.queue_seller}
        by_id.update({it.get("id"): it for it in state.queue_customer})
        by_id.update({it.get("id"): it for it in state.queue_exchange_seller})
        by_id.update({it.get("id"): it for it in state.queue_exchange_customer})

        option_sno_map = load_wonbe_option_sno_map()
        ez = EzAdminClient(get_setting)

        results = []
        for item in items:
            result = {"id": item.get("id"), "scan": item.get("scan"), "ok": False, "error": None}
            state_item = by_id.get(item.get("id"))
            try:
                option_code = str(item.get("option_code") or item.get("exchange_option_sno") or "").strip()
                if not option_code:
                    raise ValueError("option_stock_sync_code 없음")
                product_id = option_sno_map.get(option_code)
                if not product_id:
                    raise ValueError(f"원가베이스유에서 옵션번호 매칭 실패 (option_code={option_code})")
                try:
                    qty = int(float(item.get("qty") or 1))
                except (TypeError, ValueError):
                    qty = 1
                order_no = str(item.get("order_no") or item.get("order_sno") or "").strip()
                memo = f"반품입고 {order_no}".strip()
                await ez.receive_stock(product_id, qty, memo=memo)
                result["ok"] = True
                result["product_id"] = product_id
                if state_item is not None:
                    state_item["ezadmin_stockin_done"] = True
                    state_item["ezadmin_stockin_product_id"] = product_id
                    state_item.pop("ezadmin_stockin_error", None)
            except EzAdminSessionExpired:
                return {"ok": False, "need_session": True, "results": results, "queues": return_queue_payload(state)}
            except Exception as e:
                result["error"] = str(e)[:200]
                if state_item is not None:
                    state_item["ezadmin_stockin_error"] = str(e)[:200]
            results.append(result)

        return {"ok": True, "results": results, "queues": return_queue_payload(state)}

    @router.post("/returns/resolve-product-codes")
    async def returns_resolve_product_codes(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """item.option_code(반품, 에이블리 option_stock_sync_code) 또는
        item.exchange_option_sno(교환)를 원가베이스유 옵션번호와 매칭해
        상품코드만 돌려준다 (재고 변경 없음) - 김승일보내기처럼 입고처리 없이
        상품코드만 필요한 곳에서 재사용."""
        items = payload.get("items", [])
        option_sno_map = load_wonbe_option_sno_map()
        results = []
        for item in items:
            option_code = str(item.get("option_code") or item.get("exchange_option_sno") or "").strip()
            product_id = option_sno_map.get(option_code) if option_code else None
            results.append({"id": item.get("id"), "product_id": product_id})
        return {"ok": True, "results": results}

    @router.post("/returns/ably-refund-single")
    async def returns_ably_refund_single(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        cancel_sno_str = str(payload.get("cancel_sno") or "").strip()
        if not cancel_sno_str:
            raise HTTPException(status_code=400, detail="반품요청번호를 입력하세요.")

        try:
            cancel_sno_int = int(cancel_sno_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="반품요청번호는 숫자여야 합니다.")

        item_sno = None
        refund_holder = ""
        refund_account = ""
        refund_bank_sno = None

        state = get_return_state(user)
        if state.df2 is not None and not state.df2.empty:
            matched = state.df2[state.df2["REQUEST_NO"].astype(str) == cancel_sno_str]
            if not matched.empty:
                row = matched.iloc[0]
                try:
                    item_sno = int(row.get("ITEM_SNO") or 0) or None
                except (ValueError, TypeError):
                    item_sno = None
                refund_holder = str(row.get("REFUND_HOLDER") or "")
                refund_account = str(row.get("REFUND_ACCOUNT") or "")
                refund_bank_sno = row.get("REFUND_BANK_SNO")

        token = await _ably_login()
        hdrs_json = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        if item_sno is None:
            hdrs_get = {
                "Authorization": f"JWT {token}",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0",
                "Origin": "https://my.a-bly.com",
                "Referer": "https://my.a-bly.com/",
            }
            today_dt = datetime.now(timezone.utc).date()
            start_dt = today_dt - timedelta(days=365)
            found_item = None
            found_cancel_sno_int = None
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    page = 1
                    while page <= 30:
                        res = await client.get(
                            f"{ABLY_BASE}/seller/order_cancels/",
                            headers=hdrs_get,
                            params={
                                "cancel_type": "return",
                                "delivery_type[]": ["standard", "today", "combine", "reserved"],
                                "order": "-cancel_received_at",
                                "page": page,
                                "per_page": 30,
                                "start_date": start_dt.strftime("%Y-%m-%d"),
                                "end_date": today_dt.strftime("%Y-%m-%d"),
                            },
                        )
                        res.raise_for_status()
                        data = res.json()
                        for c in data.get("order_cancels", []):
                            # 최상단 sno 필드가 cancel_sno
                            if str(c.get("sno") or "") == cancel_sno_str:
                                order_items = c.get("order_items") or []
                                if order_items:
                                    found_item = order_items[0]
                                    found_cancel_sno_int = int(cancel_sno_str)
                                break
                        if found_item or page >= data.get("max_page_number", 1):
                            break
                        page += 1
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"에이블리 조회 실패: {e}")

            if not found_item:
                raise HTTPException(status_code=404, detail=f"반품요청번호 {cancel_sno_str}에 해당하는 항목을 찾을 수 없습니다.")

            try:
                item_sno = int(found_item.get("sno") or 0) or None
            except (ValueError, TypeError):
                item_sno = None
            refund_holder = str(found_item.get("refund_bank_account_holder") or "")
            refund_account = str(found_item.get("refund_bank_account_number") or "")
            refund_bank_sno = (found_item.get("refund_bank") or {}).get("sno")

        if not item_sno:
            raise HTTPException(status_code=400, detail="해당 항목의 item_sno가 없습니다.")

        async with httpx.AsyncClient(timeout=30.0) as client:
            r1 = await client.put(
                f"{ABLY_BASE}/seller/order_cancels/update_fields/",
                headers=hdrs_json,
                json={
                    "data_list": [{
                        "sno_list": [cancel_sno_int],
                        "update_list": [
                            {"field": "refund_bank_account_holder", "value": refund_holder},
                            {"field": "refund_bank_account_number", "value": refund_account},
                            {"field": "refund_bank_sno", "value": refund_bank_sno},
                        ],
                    }]
                },
            )
            r1.raise_for_status()

            r2 = await client.put(
                f"{ABLY_BASE}/seller/order_items/request_confirm/",
                headers=hdrs_json,
                json={"sno_list": [item_sno]},
            )
            r2.raise_for_status()

        return {"ok": True, "cancel_sno": cancel_sno_int, "item_sno": item_sno}

    @router.post("/returns/ably-confirm-by-item-sno")
    async def returns_ably_confirm_by_item_sno(
        payload: dict = Body(...),
        user: str = Depends(get_current_user),
    ):
        item_sno_str = str(payload.get("item_sno") or "").strip()
        if not item_sno_str:
            raise HTTPException(status_code=400, detail="item_sno를 입력하세요.")
        try:
            item_sno_int = int(item_sno_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="item_sno는 숫자여야 합니다.")

        token = await _ably_login()
        hdrs_json = {
            "Authorization": f"JWT {token}",
            "Content-Type": "application/json",
            "Origin": "https://my.a-bly.com",
            "Referer": "https://my.a-bly.com/",
            "User-Agent": "Mozilla/5.0",
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.put(
                f"{ABLY_BASE}/seller/order_items/request_confirm/",
                headers=hdrs_json,
                json={"sno_list": [item_sno_int]},
            )
            r.raise_for_status()

        return {"ok": True, "item_sno": item_sno_int}

    async def _llogis_login(principal: str, credential: str) -> str:
        async with httpx.AsyncClient(verify=False, timeout=15.0) as c:
            res = await c.post(
                LLOGIS_LOGIN_URL,
                json={"principal": principal, "credential": credential, "macAddress": "normal-browser"},
            )
            res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise HTTPException(502, "llogis 로그인 실패")
        return token

    @router.post("/returns/lotte-from-api")
    async def returns_lotte_from_api(
        date_fr: str = Body(...),
        date_to: str = Body(...),
        account: str = Body("348867"),
        user: str = Depends(get_current_user),
    ):
        acc = LLOGIS_ACCOUNTS.get(account)
        if not acc:
            raise HTTPException(400, f"알 수 없는 롯데 API 계정: {account}")
        token = await _llogis_login(acc["principal"], acc["credential"])
        filter_obj = {
            "srchPickYmd": "", "srchPickYmdStrt": date_fr, "srchPickYmdEnd": date_to,
            "cboSrchCustSctCd": "10", "srchCustCd": acc["cust_cd"], "srchCustNm": acc["cust_nm"],
            "cboSrchWkSctCd": "02", "jobCustCd": "", "tabIdx": "", "rowCount": "",
            "dispCount": "", "pickYmd": "", "colNm": "", "ustRtgSctCd": "",
            "fstmIstrYmd": "", "srchHdqrCd": "", "srchHdqrNm": "", "srchBrnCd": "",
            "srchBrnNm": "", "srchBrshCd": "", "srchBrshNm": "", "_STATUS_": "U",
        }
        hdrs = {
            "authorization": token,
            "content-type": "application/json",
            "menulink": json.dumps({
                "menuId": "22004",
                "pgmId": "100000491",
                "pgmUrl": f"{LLOGIS_PID_BASE}/pid/pages/ftr/PIDFTR017U",
            }),
            "referer": f"{LLOGIS_PID_BASE}/pid/pages/ftr/PIDFTR017U",
            "x-requested-with": "XMLHttpRequest",
        }
        async with httpx.AsyncClient(verify=False, timeout=30.0) as c:
            res = await c.get(
                f"{LLOGIS_PID_BASE}/pid/ftr/hdarvmgr/daily/dtls",
                headers=hdrs,
                params={"filter": json.dumps(filter_obj, ensure_ascii=False), "_": int(time.time() * 1000)},
            )
        if res.status_code != 200:
            raise HTTPException(502, f"llogis 조회 실패 (HTTP {res.status_code}): {res.text[:200]}")

        raw = res.json()
        items = raw if isinstance(raw, list) else (raw.get("list") or raw.get("data") or [])

        mapping: dict[str, str] = {}
        for item in items:
            if item.get("acperNm") != "유색":
                continue
            inv  = clean_invoice(str(item.get("invNo") or ""))
            orig = clean_invoice(str(item.get("orglInvNo") or ""))
            if inv and inv not in mapping:
                mapping[inv] = orig

        state = get_return_state(user)
        state.map_lotte = mapping
        return {"ok": True, "map_count": len(mapping), "status": return_status(state)}

    return router
