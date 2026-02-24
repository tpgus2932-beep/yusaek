import io
import shutil
import tempfile
import uuid
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse


def build_returns_router(
    *,
    get_current_user,
    require_admin,
    get_return_state,
    return_status,
    return_queue_payload,
    return_rows,
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

    def _df_value_to_xls_cell(value):
        if pd.isna(value):
            return ""
        if isinstance(value, bool):
            return bool(value)
        if isinstance(value, (int, float)):
            return value
        return str(value)

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

    @router.get("/returns/state")
    def returns_state(user: str = Depends(get_current_user)):
        state = get_return_state(user)
        return {
            "ok": True,
            "status": return_status(state),
            "queues": return_queue_payload(state),
            "onebe": {
                "rows": return_rows(state.customer_export_df),
            },
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
            if df.shape[1] < 2:
                raise HTTPException(status_code=400, detail="원가베이스는 최소 A,B열이 필요합니다.")
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

        q_norm = str(q).strip() if q else ""
        if q_norm:
            df_view = df.fillna("").astype(str)
            mask = df_view.apply(lambda row: row.str.contains(q_norm, case=False, na=False)).any(axis=1)
            df_filtered = df[mask].copy()
        else:
            df_filtered = df

        total = len(df_filtered)
        col_names = ["1열", "2열"]
        end = min(offset + limit, total)
        rows = []
        for i in range(offset, end):
            r = df_filtered.iloc[i]
            row = []
            for v in r.iloc[:2].values.tolist():
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

        if isinstance(column, int):
            if column < 0 or column >= len(df.columns):
                raise HTTPException(status_code=400, detail="column 범위를 벗어났습니다.")
            col_name = df.columns[column]
        else:
            if column not in df.columns:
                raise HTTPException(status_code=400, detail="유효하지 않은 column 입니다.")
            col_name = column

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
            if isinstance(column, int):
                if column < 0 or column >= len(df.columns):
                    continue
                col_name = df.columns[column]
            elif isinstance(column, str) and column in df.columns:
                col_name = column
            else:
                continue
            df.at[row_index, col_name] = "" if value is None else value

        try:
            save_cost_base_df(df)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"원가베이스 저장 실패: {e}")

        return {"ok": True}

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

        if not state.map_d_to_e:
            raise HTTPException(status_code=400, detail="먼저 1번 엑셀을 불러오세요.")
        if state.df2 is None or state.df2_index is None:
            raise HTTPException(status_code=400, detail="먼저 2번 엑셀을 불러오세요.")

        e_val = state.map_d_to_e.get(barcode, "")
        if not e_val:
            msg = f"[미매칭] 스캔:{barcode} → 1번(D)에서 찾지 못함"
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
            items = state.queue_customer
            if not items:
                raise HTTPException(status_code=400, detail="고객 대기 데이터가 없습니다.")

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
                    "매칭송장": it.get("match", ""),
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
        if (not state.queue_seller) and (not state.queue_customer) and (not state.queue_unmatched):
            raise HTTPException(status_code=400, detail="추출할 대기 데이터가 없습니다.")

        fmt = (payload.get("format") or "xlsx").lower().strip()
        if fmt not in ("xlsx", "xls"):
            fmt = "xlsx"

        df_seller = pd.DataFrame(state.queue_seller)
        df_customer = pd.DataFrame(state.queue_customer)
        df_unmatched = pd.DataFrame(state.queue_unmatched)

        for dfx in (df_seller, df_customer, df_unmatched):
            if not dfx.empty:
                dfx.drop(columns=["id"], inplace=True, errors="ignore")
                dfx.rename(
                    columns={
                        "scan": "스캔송장",
                        "match": "요청메모",
                        "item_text": "가공데이터",
                        "qty": "입고수량",
                        "type": "분류",
                    },
                    inplace=True,
                )

        buf = io.BytesIO()
        if fmt == "xlsx":
            with pd.ExcelWriter(buf, engine="openpyxl") as writer:
                df_seller.to_excel(writer, index=False, sheet_name="판매자")
                df_customer.to_excel(writer, index=False, sheet_name="고객")
                df_unmatched.to_excel(writer, index=False, sheet_name="미매칭")
            filename = "반품대기_추출.xlsx"
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            content = _build_xls_bytes_from_sheets(
                [("판매자", df_seller), ("고객", df_customer), ("미매칭", df_unmatched)]
            )
            filename = "반품대기_추출.xls"
            media_type = "application/vnd.ms-excel"
            headers = {"Content-Disposition": content_disposition(filename)}
            return Response(content=content, media_type=media_type, headers=headers)

        headers = {"Content-Disposition": content_disposition(filename)}
        return Response(content=buf.getvalue(), media_type=media_type, headers=headers)

    return router
