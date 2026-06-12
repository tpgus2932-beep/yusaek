import io
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
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from typing import List
from fastapi.responses import FileResponse

LLOGIS_LOGIN_URL  = "https://partner.alps.llogis.com/auth/login"
LLOGIS_PID_BASE   = "https://pid.alps.llogis.com:18210"
LLOGIS_PRINCIPAL  = "331595"
LLOGIS_CREDENTIAL = "plan123!"

ABLY_BASE     = "https://api.a-bly.com"
ABLY_EMAIL    = "eostm1997@naver.com"
ABLY_PASSWORD = "!Glqgkqdldi1126"

_SELLER_REASON_CODES   = {32, 1}  # 상품 하자/오배송, 셀러 변경
_SELLER_EXCHANGE_CODES = {2, 3}   # 상품 하자, 오배송 → 판매자 부담

_CANCEL_REASON_TEXT = {
    30: "단순변심",
    31: "사이즈/색상 불만족",
    32: "상품 하자/오배송",
    1:  "셀러 변경",
}


def build_returns_router(
    *,
    get_current_user,
    require_admin,
    get_return_state,
    get_db,
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
    return_cost_base_path,
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
                        for item in cancel.get("order_items", []):
                            item["_cancel_reason"] = item.get("cancel_reason")
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
                "F_name":        f_name,
                "G_opt":         g_opt,
                "QTY":           qty,
                "ITEM_TEXT":     normalize_spaces(f"{f_name} {g_opt}"),
                "REASON_TYPE":   rtype,
                "M_clean":       m_clean,
                "DETAIL_REASON": detail_reason,
                "USER_COMMENT":  user_comment,
            })

        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "REASON_TYPE", "M_clean", "DETAIL_REASON", "USER_COMMENT"])
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
            first = items_list[0]
            order_item = first.get("order_item") or {}

            goods_name    = order_item.get("goods_name") or first.get("goods_name") or ""
            option_values = (order_item.get("original_goods_option") or {}).get("option_values") or []
            option_parts  = []
            for v in option_values:
                if isinstance(v, dict):
                    option_parts.append(str(v.get("value") or v.get("name") or ""))
                else:
                    option_parts.append(str(v))
            option_str = "/".join(p for p in option_parts if p)
            qty          = str(order_item.get("quantity") or 1)
            reason_code  = ex.get("reason_code")

            f_name        = clean_product_name(goods_name)
            g_opt         = option_slash_to_space(lowercase_size_words(option_str))
            t_clean       = clean_invoice(str(t_raw))
            rtype         = "판매자" if reason_code in _SELLER_EXCHANGE_CODES else "구매자"
            detail_reason = ex.get("detail_reason") or ""

            rows.append({
                "F_name":          f_name,
                "G_opt":           g_opt,
                "QTY":             qty,
                "ITEM_TEXT":       normalize_spaces(f"{f_name} {g_opt}"),
                "EXCHANGE_REASON": rtype,
                "T_clean":         t_clean,
                "DETAIL_REASON":   detail_reason,
            })

        df = pd.DataFrame(rows) if rows else pd.DataFrame(
            columns=["F_name", "G_opt", "QTY", "ITEM_TEXT", "EXCHANGE_REASON", "T_clean", "DETAIL_REASON"])
        idx: dict[str, list[int]] = {}
        for i, v in enumerate(df["T_clean"].tolist()):
            if v:
                idx.setdefault(v, []).append(i)

        state = get_return_state(user)
        state.exchange_df    = df
        state.exchange_index = idx
        return {"ok": True, "loaded": len(rows), "index_count": len(idx), "status": return_status(state)}

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

    @router.post("/returns/cost-base/upload")
    def returns_cost_base_upload(
        file: UploadFile = File(...),
        admin: str = Depends(require_admin),
    ):
        ext = Path(file.filename or "").suffix.lower()
        if ext not in return_allowed_exts:
            raise HTTPException(status_code=400, detail="xls/xlsx/xlsm만 업로드 가능")

        return_cost_base_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = Path(tempfile.gettempdir()) / f"returns_cost_base_{uuid.uuid4().hex}{ext}"
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        try:
            df = read_return_excel(tmp_path)
            if df.shape[1] < COST_BASE_REQUIRED_COLS:
                raise HTTPException(status_code=400, detail="원가베이스는 최소 A~I열이 필요합니다.")
            shutil.move(str(tmp_path), str(return_cost_base_path))
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

        state = get_return_state(admin)
        state.cost_base_path = return_cost_base_path
        load_return_cost_base(state)

        return {"ok": True, "status": return_status(state)}

    @router.get("/returns/cost-base/download")
    def returns_cost_base_download(admin: str = Depends(require_admin)):
        path = return_cost_base_path
        if not path.exists():
            raise HTTPException(status_code=404, detail="원가베이스 파일이 없습니다.")
        return FileResponse(path, filename=path.name)

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
        col_names = ["A열 상품코드", "I열 상품명 색상 사이즈"]
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
        if not name and not code:
            raise HTTPException(status_code=400, detail="A열 또는 I열 값을 입력하세요.")

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
        state.cost_base_path = return_cost_base_path
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
        state.cost_base_path = return_cost_base_path
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
            return {"ok": True, "last_type": state.last_type, "sound_type": sound_type, "queues": return_queue_payload(state)}

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
                "detail_reason": row.get("DETAIL_REASON", ""),
                "user_comment": row.get("USER_COMMENT", ""),
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
        return {"ok": True, "last_type": state.last_type, "queues": return_queue_payload(state)}

    @router.post("/returns/undo")
    def returns_undo(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        if not state.last_added_ids:
            raise HTTPException(status_code=400, detail="삭제할 최근 스캔 기록이 없습니다.")

        remove_ids = set(state.last_added_ids)
        state.queue_seller = [it for it in state.queue_seller if it.get("id") not in remove_ids]
        state.queue_customer = [it for it in state.queue_customer if it.get("id") not in remove_ids]
        state.queue_unmatched = [it for it in state.queue_unmatched if it.get("id") not in remove_ids]
        state.queue_exchange = [it for it in state.queue_exchange if it.get("id") not in remove_ids]
        state.queue_exchange_seller = [it for it in state.queue_exchange_seller if it.get("id") not in remove_ids]
        state.queue_exchange_customer = [it for it in state.queue_exchange_customer if it.get("id") not in remove_ids]
        state.all_items = [it for it in state.all_items if it.get("id") not in remove_ids]
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

    async def _llogis_login() -> str:
        async with httpx.AsyncClient(verify=False, timeout=15.0) as c:
            res = await c.post(
                LLOGIS_LOGIN_URL,
                json={"principal": LLOGIS_PRINCIPAL, "credential": LLOGIS_CREDENTIAL, "macAddress": "normal-browser"},
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
        user: str = Depends(get_current_user),
    ):
        token = await _llogis_login()
        filter_obj = {
            "srchPickYmd": "", "srchPickYmdStrt": date_fr, "srchPickYmdEnd": date_to,
            "cboSrchCustSctCd": "10", "srchCustCd": "331595", "srchCustNm": "바브",
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
