import io
import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd


def _read_return_excel(path: Path) -> pd.DataFrame:
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    if ext == ".xls":
        try:
            return pd.read_excel(path, dtype=str, engine="xlrd")
        except Exception:
            return pd.read_excel(path, dtype=str)
    try:
        return pd.read_excel(path, dtype=str, engine="openpyxl")
    except Exception:
        try:
            return pd.read_excel(path, dtype=str, engine="xlrd")
        except Exception as e:
            raise ValueError(f"지원 형식: xlsx, xls, xlsm (읽기 실패: {e})")


def _read_return_excel_with_header(path: Path, header):
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(path, dtype=str, engine="openpyxl", header=header)
    if ext == ".xls":
        try:
            return pd.read_excel(path, dtype=str, engine="xlrd", header=header)
        except Exception:
            return pd.read_excel(path, dtype=str, header=header)
    try:
        return pd.read_excel(path, dtype=str, engine="openpyxl", header=header)
    except Exception:
        return pd.read_excel(path, dtype=str, engine="xlrd", header=header)


def _clean_invoice(value: str) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    if s.lower() in ("nan", "none"):
        return ""
    s = re.sub(r"\.0$", "", s)
    return re.sub(r"\D+", "", s)


def _clean_product_name(text: str) -> str:
    if text is None:
        return ""
    s = str(text)
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _option_slash_to_space(opt: str) -> str:
    if opt is None:
        return ""
    s = str(opt).strip()
    if s.lower() in ("nan", "none"):
        return ""
    parts = [p.strip() for p in s.split("/") if p.strip()]
    return " ".join(parts)


def _normalize_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def _normalize_key(s: str) -> str:
    if s is None:
        return ""
    s = str(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.casefold()


def _reason_type(k_value: str) -> str:
    s = "" if k_value is None else str(k_value).strip()
    if s.lower() in ("nan", "none"):
        return "미매칭"
    s2 = re.sub(r"\([^)]*\)", "", s).strip()
    if s2.startswith("판매자"):
        return "판매자"
    if s2.startswith("고객"):
        return "고객"
    return "미매칭"


def _clean_qty(x) -> str:
    if x is None:
        return ""
    s = str(x).strip()
    if s.lower() in ("nan", "none", ""):
        return ""
    s = re.sub(r"\.0$", "", s)
    return s


def _lowercase_size_words(text: str) -> str:
    if text is None:
        return ""
    s = str(text)
    size_words = ["FREE", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "SHORT", "LONG"]
    for w in size_words:
        s = re.sub(rf"\b{w}\b", w.lower(), s, flags=re.IGNORECASE)
    return s


class ReturnState:
    def __init__(self, cost_base_path: Path):
        self.df1: pd.DataFrame | None = None
        self.df_lotte: pd.DataFrame | None = None
        self.df2: pd.DataFrame | None = None
        self.exchange_df: pd.DataFrame | None = None
        self.map_d_to_e: dict[str, str] = {}
        self.map_lotte: dict[str, str] = {}
        self.df2_index: dict[str, list[int]] = {}
        self.exchange_index: dict[str, list[int]] = {}
        self.queue_seller: list[dict] = []
        self.queue_customer: list[dict] = []
        self.queue_unmatched: list[dict] = []
        self.queue_exchange: list[dict] = []
        self.queue_exchange_seller: list[dict] = []
        self.queue_exchange_customer: list[dict] = []
        self.all_items: list[dict] = []
        self.last_added_ids: list[int] = []
        self.scanned_barcodes: set[str] = set()
        self.cost_map: dict[str, str] = {}
        self.cost_base_path: Path = cost_base_path
        self.customer_export_df: pd.DataFrame = pd.DataFrame()
        self.last_type: str = "-"
        self.next_id: int = 1


def _return_df_to_json(df: pd.DataFrame | None) -> str | None:
    if df is None:
        return None
    return df.to_json(orient="split", force_ascii=False)


def _return_df_from_json(raw: str | None) -> pd.DataFrame | None:
    if not raw:
        return None
    return pd.read_json(io.StringIO(raw), orient="split", dtype=False)


def _return_state_to_payload(state: ReturnState) -> dict:
    return {
        "df1": _return_df_to_json(state.df1),
        "df_lotte": _return_df_to_json(state.df_lotte),
        "df2": _return_df_to_json(state.df2),
        "exchange_df": _return_df_to_json(state.exchange_df),
        "map_d_to_e": state.map_d_to_e,
        "map_lotte": state.map_lotte,
        "df2_index": state.df2_index,
        "exchange_index": state.exchange_index,
        "queue_seller": state.queue_seller,
        "queue_customer": state.queue_customer,
        "queue_unmatched": state.queue_unmatched,
        "queue_exchange": state.queue_exchange,
        "queue_exchange_seller": state.queue_exchange_seller,
        "queue_exchange_customer": state.queue_exchange_customer,
        "all_items": state.all_items,
        "last_added_ids": state.last_added_ids,
        "scanned_barcodes": sorted(state.scanned_barcodes),
        "cost_map": state.cost_map,
        "customer_export_df": _return_df_to_json(state.customer_export_df),
        "last_type": state.last_type,
        "next_id": state.next_id,
    }


def _load_return_state_from_payload(state: ReturnState, payload: dict | None):
    payload = payload or {}
    state.df1 = _return_df_from_json(payload.get("df1"))
    state.df_lotte = _return_df_from_json(payload.get("df_lotte"))
    state.df2 = _return_df_from_json(payload.get("df2"))
    state.exchange_df = _return_df_from_json(payload.get("exchange_df"))
    state.map_d_to_e = dict(payload.get("map_d_to_e") or {})
    state.map_lotte = dict(payload.get("map_lotte") or {})
    state.df2_index = {str(k): list(v) for k, v in dict(payload.get("df2_index") or {}).items()}
    state.exchange_index = {str(k): list(v) for k, v in dict(payload.get("exchange_index") or {}).items()}
    state.queue_seller = list(payload.get("queue_seller") or [])
    state.queue_customer = list(payload.get("queue_customer") or [])
    state.queue_unmatched = list(payload.get("queue_unmatched") or [])
    state.queue_exchange = list(payload.get("queue_exchange") or [])
    state.queue_exchange_seller = list(payload.get("queue_exchange_seller") or [])
    state.queue_exchange_customer = list(payload.get("queue_exchange_customer") or [])
    state.all_items = list(payload.get("all_items") or [])
    state.last_added_ids = [int(v) for v in list(payload.get("last_added_ids") or [])]
    state.scanned_barcodes = set(str(v) for v in list(payload.get("scanned_barcodes") or []))
    state.cost_map = dict(payload.get("cost_map") or {})
    customer_export_df = _return_df_from_json(payload.get("customer_export_df"))
    state.customer_export_df = customer_export_df if customer_export_df is not None else pd.DataFrame()
    state.last_type = str(payload.get("last_type") or "-")
    try:
        state.next_id = max(int(payload.get("next_id") or 1), 1)
    except Exception:
        state.next_id = 1


def _return_status(state: ReturnState) -> dict:
    path = state.cost_base_path
    exists = path.exists()
    mtime = None
    if exists:
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
        except Exception:
            mtime = None
    return {
        "excel1_loaded": state.df1 is not None,
        "lotte_loaded": state.df_lotte is not None,
        "excel2_loaded": state.df2 is not None,
        "exchange_loaded": state.exchange_df is not None,
        "cost_loaded": bool(state.cost_map),
        "map_count": len(state.map_d_to_e),
        "map_lotte_count": len(state.map_lotte),
        "index_count": len(state.df2_index),
        "exchange_index_count": len(state.exchange_index),
        "cost_count": len(state.cost_map),
        "cost_base_path": str(path),
        "cost_base_exists": exists,
        "cost_base_mtime": mtime,
    }


def _return_rows(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    rows = []
    for _, r in df.iterrows():
        item = {}
        for k, v in r.items():
            if pd.isna(v):
                item[k] = ""
            else:
                item[k] = v
        rows.append(item)
    return rows


def _return_queue_payload(state: ReturnState) -> dict:
    exchange_seller = list(state.queue_exchange_seller)
    exchange_customer = list(state.queue_exchange_customer)
    legacy_exchange = list(state.queue_exchange)
    if legacy_exchange:
        exchange_customer.extend(legacy_exchange)
    return {
        "seller": state.queue_seller,
        "customer": state.queue_customer,
        "unmatched": state.queue_unmatched,
        "exchange_seller": exchange_seller,
        "exchange_customer": exchange_customer,
        "exchange": exchange_seller + exchange_customer,
        "all": state.all_items,
    }
