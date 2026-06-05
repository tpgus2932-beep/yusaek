import json
import re
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

import pandas as pd


DB_PATH = Path(r"C:\Users\ksh29\OneDrive\Desktop\원베\재고컨트롤데이터베이스.xlsx")
PRESET_PATH = Path(__file__).with_name("가공_presets.json")
SNAPSHOT_PATH = Path(__file__).with_name("가공_db_snapshot.xlsx")

PRODUCT_OPTION_COL = "상품명옵션"
PRODUCT_NO_COL = "상품번호"
OPTION_NO_COL = "옵션번호"
PRICE_COL = "매립가"
DB_EXTRA_H_COL = "할인전 판매가"
DISCOUNT_SALE_COL = "할인 판매가"
SELL_OUT_METHOD_COL = "재고 소진 시 판매 방식 (번호로 입력)"

PRICE_BATCH_PRESET = "상품가 일괄 변경"

BUILTIN_PRESETS = [
    {
        "label": "기본",
        "columns": [
            (PRODUCT_NO_COL, "상품번호"),
            (OPTION_NO_COL, "옵션번호"),
            (PRICE_COL, "매립가"),
            (DB_EXTRA_H_COL, "할인전 판매가"),
            (PRODUCT_OPTION_COL, "상품명옵션"),
        ],
    },
    {
        "label": "매칭확인",
        "columns": [
            (PRODUCT_OPTION_COL, "상품명옵션"),
            (PRODUCT_NO_COL, "상품번호"),
            (OPTION_NO_COL, "옵션번호"),
            (PRICE_COL, "매립가"),
            (DB_EXTRA_H_COL, "할인전 판매가"),
        ],
    },
    {
        "label": "전체",
        "columns": None,
    },
    {
        "label": PRICE_BATCH_PRESET,
        "columns": [
            (PRODUCT_NO_COL, "상품번호"),
            (DB_EXTRA_H_COL, "판매가"),
            (DISCOUNT_SALE_COL, "할인 판매가"),
        ],
    },
    {
        "label": "판매방식변경",
        "columns": [
            (OPTION_NO_COL, "에이블리 옵션 번호"),
            (SELL_OUT_METHOD_COL, "재고 소진 시 판매 방식 (번호로 입력)"),
        ],
    },
]


def _read_head(file_path: str, size: int = 4096) -> bytes:
    with open(file_path, "rb") as handle:
        return handle.read(size)


def load_file(file_path: str) -> pd.DataFrame:
    path = Path(file_path)
    suffix = path.suffix.lower()
    head = _read_head(file_path)

    if suffix in {".xlsx", ".xlsm"} or head[:2] == b"PK":
        return pd.read_excel(file_path, engine="openpyxl")

    if suffix == ".xls":
        if head.startswith(b"\xD0\xCF\x11\xE0"):
            return pd.read_excel(file_path, engine="xlrd")

        lowered = head.lstrip(b"\xef\xbb\xbf").lower()
        if lowered.startswith(b"<html") or b"<table" in lowered:
            tables = pd.read_html(file_path, header=0)
            if not tables:
                raise ValueError("XLS 파일 안에서 표를 찾지 못했습니다.")
            return tables[0]

        for encoding in ("utf-8-sig", "cp949", "utf-8"):
            try:
                return pd.read_csv(file_path, encoding=encoding)
            except Exception:
                continue

        raise ValueError("XLS 파일을 읽지 못했습니다.")

    if suffix == ".csv":
        for encoding in ("utf-8-sig", "cp949", "utf-8"):
            try:
                return pd.read_csv(file_path, encoding=encoding)
            except Exception:
                continue
        raise ValueError("CSV 파일 인코딩을 읽지 못했습니다.")

    raise ValueError("지원 형식은 .xlsx / .xls / .xlsm / .csv 입니다.")


def normalize_option_text(value: object) -> str:
    if pd.isna(value):
        return ""

    text = str(value).strip()
    if not text:
        return ""

    text = re.sub(r"[\[\]\{\}]", " ", text)
    text = re.sub(r"_(?=.)", " ", text)
    text = re.sub(r"-(?!\d+\b)", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_match_text(value: object) -> str:
    if pd.isna(value):
        return ""
    normalized = re.sub(r"\s+", " ", str(value).strip())
    return normalized.casefold()


def build_product_option(name_value: object, option_value: object) -> str:
    name = "" if pd.isna(name_value) else str(name_value).strip()
    option = normalize_option_text(option_value)
    combined = f"{name} {option}".strip()
    return normalize_match_text(combined)


def load_database_lookup() -> pd.DataFrame:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"원베 파일을 찾지 못했습니다.\n{DB_PATH}")

    db_df = pd.read_excel(DB_PATH, engine="openpyxl")
    if len(db_df.columns) < 8:
        raise ValueError("재고컨트롤데이터베이스.xlsx 컬럼 수가 부족합니다. H열까지 필요합니다.")

    key_col = db_df.columns[1]
    product_no_col = db_df.columns[4]
    option_no_col = db_df.columns[5]
    price_col = db_df.columns[6]
    extra_h_col = db_df.columns[7]

    lookup_df = db_df[[key_col, product_no_col, option_no_col, price_col, extra_h_col]].copy()
    lookup_df.columns = [key_col, PRODUCT_NO_COL, OPTION_NO_COL, PRICE_COL, DB_EXTRA_H_COL]
    lookup_df["_match_key"] = lookup_df[key_col].map(normalize_match_text)
    lookup_df = lookup_df[lookup_df["_match_key"] != ""]
    lookup_df = lookup_df.drop_duplicates("_match_key", keep="first")
    return lookup_df.set_index("_match_key")


def process_excel(file_path: str) -> pd.DataFrame:
    df = load_file(file_path)

    if len(df.columns) < 8:
        raise ValueError(f"컬럼 수가 부족합니다. 현재 {len(df.columns)}개입니다.")

    col_b = df.columns[1]
    col_e = df.columns[4]
    col_f = df.columns[5]
    col_h = df.columns[7]

    df[col_h] = pd.to_datetime(df[col_h], errors="coerce")
    df[col_f] = pd.to_numeric(df[col_f], errors="coerce").fillna(0)

    h_limit = datetime.today() - timedelta(days=15)
    df["_date_condition"] = df[col_h].isna() | (df[col_h] <= h_limit)

    def group_condition(group: pd.DataFrame) -> bool:
        all_rows_match_date_condition = group["_date_condition"].all()
        has_row_with_quantity_over_or_equal_1 = (group[col_f] >= 1).any()
        return bool(all_rows_match_date_condition and has_row_with_quantity_over_or_equal_1)

    filtered_df = df.groupby(col_b, dropna=False).filter(group_condition).copy()
    filtered_df = filtered_df.drop(columns=["_date_condition"])
    filtered_df[PRODUCT_OPTION_COL] = filtered_df.apply(
        lambda row: build_product_option(row[col_b], row[col_e]),
        axis=1,
    )

    lookup_df = load_database_lookup()
    match_keys = filtered_df[PRODUCT_OPTION_COL].map(normalize_match_text)
    matched_rows = lookup_df.reindex(match_keys)

    insert_at = min(12, len(filtered_df.columns))
    filtered_df.insert(insert_at, DB_EXTRA_H_COL, matched_rows[DB_EXTRA_H_COL].to_list())
    filtered_df[PRODUCT_NO_COL] = matched_rows[PRODUCT_NO_COL].to_list()
    filtered_df[OPTION_NO_COL] = matched_rows[OPTION_NO_COL].to_list()
    filtered_df[PRICE_COL] = matched_rows[PRICE_COL].to_list()

    price_series = pd.to_numeric(filtered_df[PRICE_COL], errors="coerce")
    filtered_df[DISCOUNT_SALE_COL] = price_series.mul(0.93).div(10).round().mul(10)
    filtered_df[SELL_OUT_METHOD_COL] = 1
    return filtered_df


def load_user_presets() -> list[dict[str, object]]:
    if not PRESET_PATH.exists():
        return []
    try:
        data = json.loads(PRESET_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []

    presets: list[dict[str, object]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label", "")).strip()
        columns = item.get("columns")
        if not label or not isinstance(columns, list):
            continue
        cleaned_columns: list[tuple[str, str]] = []
        for pair in columns:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                continue
            cleaned_columns.append((str(pair[0]), str(pair[1])))
        presets.append({"label": label, "columns": cleaned_columns})
    return presets


def save_user_presets() -> None:
    payload = []
    for preset in user_presets:
        payload.append(
            {
                "label": preset["label"],
                "columns": [[source, header] for source, header in preset["columns"]],
            }
        )
    PRESET_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_compare_value(value: object) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value).strip()


def build_signature_counter(df: pd.DataFrame) -> tuple[pd.DataFrame, Counter]:
    compare_df = df.copy()
    compare_df.columns = [str(col) for col in compare_df.columns]
    normalized_df = compare_df.applymap(normalize_compare_value)
    signatures = normalized_df.apply(lambda row: "\x1f".join(row.tolist()), axis=1)
    return compare_df, Counter(signatures.tolist())


def subtract_rows_by_counter(df: pd.DataFrame, signatures: pd.Series, to_remove: Counter) -> pd.DataFrame:
    keep_rows = []
    working_counter = Counter(to_remove)
    for idx, signature in signatures.items():
        if working_counter[signature] > 0:
            working_counter[signature] -= 1
            continue
        keep_rows.append(idx)
    return df.loc[keep_rows].copy()


def get_compare_key_series(df: pd.DataFrame) -> pd.Series:
    if PRODUCT_OPTION_COL not in df.columns:
        raise ValueError(f"비교 기준 열 '{PRODUCT_OPTION_COL}'을 찾을 수 없습니다.")
    return df[PRODUCT_OPTION_COL].map(normalize_match_text)


root = tk.Tk()
root.title("묶음 자동 필터")
root.geometry("1600x940")
root.minsize(1280, 780)

current_file_path = ""
current_df = pd.DataFrame()
column_controls: list[dict[str, object]] = []
user_presets = load_user_presets()
active_preset_label = ""


def _display_value(value: object) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    return str(value)


def refresh_preview(df: pd.DataFrame) -> None:
    preview_tree.delete(*preview_tree.get_children())
    preview_tree["columns"] = [str(col) for col in df.columns]

    for col in df.columns:
        preview_tree.heading(str(col), text=str(col))
        preview_tree.column(str(col), width=140, stretch=True, anchor="w")

    for _, row in df.head(200).iterrows():
        values = [_display_value(row[col]) for col in df.columns]
        preview_tree.insert("", "end", values=values)


def clear_column_controls() -> None:
    global column_controls
    for widget in columns_inner.winfo_children():
        widget.destroy()
    column_controls = []


def render_column_controls() -> None:
    for widget in columns_inner.winfo_children():
        widget.destroy()

    for idx, control in enumerate(column_controls):
        row_frame = tk.Frame(columns_inner, bd=1, relief="solid", padx=8, pady=6)
        row_frame.grid(row=idx, column=0, sticky="ew", pady=(0, 6))
        row_frame.grid_columnconfigure(5, weight=1)

        tk.Checkbutton(row_frame, variable=control["include_var"]).grid(row=0, column=0, sticky="w")
        tk.Label(row_frame, text=str(idx + 1), width=3, anchor="w").grid(row=0, column=1, sticky="w", padx=(4, 8))
        tk.Label(row_frame, text=str(control["source"]), width=20, anchor="w").grid(row=0, column=2, sticky="w", padx=(0, 8))
        tk.Button(row_frame, text="▲", width=3, command=lambda idx=idx: move_column(idx, -1)).grid(row=0, column=3, padx=(0, 2))
        tk.Button(row_frame, text="▼", width=3, command=lambda idx=idx: move_column(idx, 1)).grid(row=0, column=4, padx=(0, 8))
        tk.Entry(row_frame, textvariable=control["header_var"]).grid(row=0, column=5, sticky="ew")


def populate_column_controls(df: pd.DataFrame) -> None:
    clear_column_controls()
    for col in df.columns:
        column_controls.append(
            {
                "source": str(col),
                "include_var": tk.BooleanVar(value=True),
                "header_var": tk.StringVar(value=str(col)),
            }
        )
    render_column_controls()


def move_column(index: int, delta: int) -> None:
    target = index + delta
    if target < 0 or target >= len(column_controls):
        return
    column_controls[index], column_controls[target] = column_controls[target], column_controls[index]
    render_column_controls()


def set_all_columns(value: bool) -> None:
    for control in column_controls:
        control["include_var"].set(value)


def reset_headers() -> None:
    for control in column_controls:
        control["header_var"].set(str(control["source"]))


def get_current_preset_columns() -> list[tuple[str, str]]:
    selected_columns: list[tuple[str, str]] = []
    for control in column_controls:
        if control["include_var"].get():
            selected_columns.append((str(control["source"]), control["header_var"].get().strip() or str(control["source"])))
    return selected_columns


def apply_columns_config(columns: list[tuple[str, str]] | None, label: str) -> None:
    global active_preset_label
    if not column_controls:
        messagebox.showwarning("안내", "먼저 파일을 가공하세요.")
        return

    if columns is None:
        set_all_columns(True)
        reset_headers()
        active_preset_label = label
        preset_var.set(f"적용 프리셋: {label}")
        return

    mapping = {source: header for source, header in columns}
    reordered_controls: list[dict[str, object]] = []
    remaining_controls = column_controls[:]

    for source, _header in columns:
        for idx, control in enumerate(remaining_controls):
            if control["source"] == source:
                reordered_controls.append(control)
                remaining_controls.pop(idx)
                break

    if not reordered_controls:
        messagebox.showwarning("안내", f"{label} 프리셋과 일치하는 컬럼이 없습니다.")
        return

    reordered_controls.extend(remaining_controls)
    column_controls[:] = reordered_controls

    set_all_columns(False)
    reset_headers()

    applied_count = 0
    for control in column_controls:
        source = str(control["source"])
        if source in mapping:
            control["include_var"].set(True)
            control["header_var"].set(mapping[source])
            applied_count += 1

    render_column_controls()
    active_preset_label = label
    preset_var.set(f"적용 프리셋: {label} ({applied_count}개 열)")


def apply_builtin_preset(preset: dict[str, object]) -> None:
    apply_columns_config(preset["columns"], str(preset["label"]))


def render_user_preset_buttons() -> None:
    for widget in user_preset_buttons.winfo_children():
        widget.destroy()

    if not user_presets:
        tk.Label(user_preset_buttons, text="저장된 사용자 프리셋 없음", fg="#666666").pack(anchor="w")
        return

    for preset in user_presets:
        row = tk.Frame(user_preset_buttons)
        row.pack(fill="x", pady=(0, 4))

        tk.Button(
            row,
            text=str(preset["label"]),
            command=lambda preset=preset: apply_columns_config(preset["columns"], str(preset["label"])),
        ).pack(side="left")

        tk.Button(
            row,
            text="삭제",
            command=lambda preset=preset: delete_user_preset(str(preset["label"])),
        ).pack(side="left", padx=(6, 0))


def save_current_as_preset() -> None:
    if not column_controls:
        messagebox.showwarning("안내", "먼저 파일을 가공하세요.")
        return

    selected_columns = get_current_preset_columns()
    if not selected_columns:
        messagebox.showwarning("안내", "프리셋으로 저장할 선택 열이 없습니다.")
        return

    name = simpledialog.askstring("프리셋 저장", "프리셋 이름을 입력하세요.", parent=root)
    if name is None:
        return
    name = name.strip()
    if not name:
        messagebox.showwarning("안내", "프리셋 이름이 비어 있습니다.")
        return

    for preset in BUILTIN_PRESETS:
        if str(preset["label"]) == name:
            messagebox.showwarning("안내", "기본 프리셋 이름과는 같은 이름을 사용할 수 없습니다.")
            return

    replaced = False
    for preset in user_presets:
        if str(preset["label"]) == name:
            preset["columns"] = selected_columns
            replaced = True
            break

    if not replaced:
        user_presets.append({"label": name, "columns": selected_columns})

    save_user_presets()
    render_user_preset_buttons()
    preset_var.set(f"저장된 프리셋: {name}")
    messagebox.showinfo("완료", f"프리셋 저장 완료\n{name}")


def delete_user_preset(label: str) -> None:
    if not messagebox.askyesno("프리셋 삭제", f"{label} 프리셋을 삭제할까요?"):
        return

    for idx, preset in enumerate(user_presets):
        if str(preset["label"]) == label:
            user_presets.pop(idx)
            save_user_presets()
            render_user_preset_buttons()
            preset_var.set(f"삭제된 프리셋: {label}")
            return


def save_db_snapshot() -> None:
    if current_df.empty:
        messagebox.showwarning("안내", "먼저 파일을 가공하세요.")
        return

    current_df.to_excel(SNAPSHOT_PATH, index=False)
    result_var.set(f"DB 저장 완료: {SNAPSHOT_PATH.name}")
    messagebox.showinfo("완료", f"DB 저장 완료\n{SNAPSHOT_PATH}")


def compare_with_db_snapshot() -> None:
    if current_df.empty:
        messagebox.showwarning("안내", "먼저 파일을 가공하세요.")
        return
    if not SNAPSHOT_PATH.exists():
        messagebox.showwarning("안내", "저장된 DB 기준 파일이 없습니다. 먼저 DB저장 버튼을 눌러주세요.")
        return

    snapshot_df = pd.read_excel(SNAPSHOT_PATH, dtype=object)
    current_compare_df = current_df.copy()

    snapshot_df.columns = [str(col) for col in snapshot_df.columns]
    current_compare_df.columns = [str(col) for col in current_compare_df.columns]
    snapshot_keys = get_compare_key_series(snapshot_df)
    current_keys = get_compare_key_series(current_compare_df)

    snapshot_key_set = {key for key in snapshot_keys if key}
    current_key_set = {key for key in current_keys if key}

    added_keys = current_key_set - snapshot_key_set
    removed_keys = snapshot_key_set - current_key_set

    added_df = current_compare_df.loc[current_keys.isin(added_keys)].copy()
    removed_df = snapshot_df.loc[snapshot_keys.isin(removed_keys)].copy()

    if not added_df.empty:
        added_df = added_df.assign(_compare_key=current_keys.loc[added_df.index].values)
        added_df = added_df.drop_duplicates("_compare_key", keep="first").drop(columns="_compare_key")
    if not removed_df.empty:
        removed_df = removed_df.assign(_compare_key=snapshot_keys.loc[removed_df.index].values)
        removed_df = removed_df.drop_duplicates("_compare_key", keep="first").drop(columns="_compare_key")

    if added_df.empty and removed_df.empty:
        result_var.set("DB 비교 완료: 변경 없음")
        messagebox.showinfo("비교 완료", "새로 생기거나 사라진 데이터가 없습니다.")
        return

    compare_save_path = filedialog.asksaveasfilename(
        title="DB 비교 결과 저장",
        defaultextension=".xlsx",
        initialfile="DB비교결과.xlsx",
        filetypes=[("Excel files", "*.xlsx")],
    )
    if not compare_save_path:
        return

    with pd.ExcelWriter(compare_save_path, engine="openpyxl") as writer:
        added_df.to_excel(writer, index=False, sheet_name="새로생김")
        removed_df.to_excel(writer, index=False, sheet_name="사라짐")

    result_var.set(f"DB 비교 완료: 새로생김 {len(added_df)}건 / 사라짐 {len(removed_df)}건")
    messagebox.showinfo(
        "비교 완료",
        f"새로생김: {len(added_df)}건\n사라짐: {len(removed_df)}건\n\n저장 위치:\n{compare_save_path}",
    )


def save_processed_file() -> None:
    if current_df.empty:
        messagebox.showwarning("안내", "먼저 파일을 가공하세요.")
        return

    selected_sources: list[str] = []
    renamed_headers: list[str] = []

    for control in column_controls:
        if not control["include_var"].get():
            continue
        header = control["header_var"].get().strip()
        if not header:
            messagebox.showwarning("안내", f"{control['source']} 컬럼의 헤더명이 비어 있습니다.")
            return
        selected_sources.append(str(control["source"]))
        renamed_headers.append(header)

    if not selected_sources:
        messagebox.showwarning("안내", "다운로드할 열을 최소 1개 이상 선택하세요.")
        return

    initial_name = "가공완료.xlsx"
    if current_file_path:
        initial_name = f"{Path(current_file_path).stem}_가공완료.xlsx"

    save_path = filedialog.asksaveasfilename(
        title="가공 엑셀 저장",
        defaultextension=".xlsx",
        initialfile=initial_name,
        filetypes=[("Excel files", "*.xlsx")],
    )
    if not save_path:
        return

    export_df = current_df.loc[:, selected_sources].copy()
    if active_preset_label == PRICE_BATCH_PRESET and selected_sources:
        export_df = export_df.drop_duplicates(subset=[selected_sources[0]], keep="first")
    export_df.columns = renamed_headers
    export_df.to_excel(save_path, index=False)
    messagebox.showinfo("완료", f"파일 저장 완료\n{save_path}")


def run_processing(file_path: str) -> None:
    global current_file_path, current_df, active_preset_label

    processed_df = process_excel(file_path)
    current_file_path = file_path
    current_df = processed_df
    active_preset_label = ""

    file_value_var.set(Path(file_path).name)
    result_var.set(f"가공 완료: {len(processed_df)}행 / 미리보기는 200행까지 표시")
    preset_var.set("적용 프리셋: 없음")
    populate_column_controls(processed_df)
    refresh_preview(processed_df)

    save_button.config(state="normal")
    save_db_button.config(state="normal")
    compare_db_button.config(state="normal")
    select_all_button.config(state="normal")
    clear_all_button.config(state="normal")
    reset_headers_button.config(state="normal")
    save_preset_button.config(state="normal")


def select_file() -> None:
    file_path = filedialog.askopenfilename(
        title="가공할 파일 선택",
        filetypes=[("Excel/CSV files", "*.xlsx *.xls *.xlsm *.csv")],
    )
    if not file_path:
        return

    try:
        run_processing(file_path)
    except Exception as exc:
        messagebox.showerror("오류", str(exc))


toolbar = tk.Frame(root, padx=16, pady=14)
toolbar.pack(fill="x")

tk.Label(toolbar, text="가공 엑셀 내보내기", font=("Malgun Gothic", 15, "bold")).pack(anchor="w")
tk.Label(
    toolbar,
    text="파일을 가공한 뒤 필요한 열만 선택하고, 헤더명과 열순서를 맞춘 뒤 저장합니다. DB 저장과 비교도 가능합니다.",
    fg="#444444",
).pack(anchor="w", pady=(4, 10))

action_row = tk.Frame(toolbar)
action_row.pack(fill="x")

tk.Button(action_row, text="파일 선택 및 가공", command=select_file, height=2, padx=16).pack(side="left")

save_button = tk.Button(action_row, text="선택 열만 저장", command=save_processed_file, height=2, padx=16, state="disabled")
save_button.pack(side="left", padx=(8, 0))

save_db_button = tk.Button(action_row, text="DB저장", command=save_db_snapshot, height=2, padx=16, state="disabled")
save_db_button.pack(side="left", padx=(8, 0))

compare_db_button = tk.Button(action_row, text="DB와 비교", command=compare_with_db_snapshot, height=2, padx=16, state="disabled")
compare_db_button.pack(side="left", padx=(8, 0))

file_value_var = tk.StringVar(value="선택된 파일 없음")
tk.Label(action_row, textvariable=file_value_var, anchor="w").pack(side="left", padx=(16, 0))

result_var = tk.StringVar(value="가공 전")
tk.Label(toolbar, textvariable=result_var, anchor="w", fg="#0b5c8c").pack(anchor="w", pady=(8, 0))

preset_var = tk.StringVar(value="적용 프리셋: 없음")

body = tk.PanedWindow(root, sashrelief="raised", sashwidth=6)
body.pack(fill="both", expand=True, padx=16, pady=(0, 16))

left_panel = tk.Frame(body, padx=4, pady=4)
right_panel = tk.Frame(body, padx=4, pady=4)
body.add(left_panel, minsize=560)
body.add(right_panel, minsize=720)

tk.Label(left_panel, text="다운로드 컬럼 설정", font=("Malgun Gothic", 12, "bold")).pack(anchor="w")
tk.Label(
    left_panel,
    text="체크된 열만 저장됩니다. ▲▼로 열순서를 바꾸고, 오른쪽 입력칸에서 저장될 헤더명을 수정하세요.",
    justify="left",
    fg="#444444",
).pack(anchor="w", pady=(4, 10))

left_actions = tk.Frame(left_panel)
left_actions.pack(fill="x", pady=(0, 8))

select_all_button = tk.Button(left_actions, text="전체 선택", command=lambda: set_all_columns(True), state="disabled")
select_all_button.pack(side="left")

clear_all_button = tk.Button(left_actions, text="전체 해제", command=lambda: set_all_columns(False), state="disabled")
clear_all_button.pack(side="left", padx=(6, 0))

reset_headers_button = tk.Button(left_actions, text="헤더 원복", command=reset_headers, state="disabled")
reset_headers_button.pack(side="left", padx=(6, 0))

save_preset_button = tk.Button(left_actions, text="현재 조합 저장", command=save_current_as_preset, state="disabled")
save_preset_button.pack(side="left", padx=(6, 0))

tk.Label(left_panel, text="기본 프리셋", font=("Malgun Gothic", 10, "bold")).pack(anchor="w", pady=(4, 6))

builtin_preset_row = tk.Frame(left_panel)
builtin_preset_row.pack(fill="x", pady=(0, 6))

for preset in BUILTIN_PRESETS:
    tk.Button(
        builtin_preset_row,
        text=str(preset["label"]),
        command=lambda preset=preset: apply_builtin_preset(preset),
    ).pack(side="left", padx=(0, 6))

tk.Label(left_panel, text="사용자 프리셋", font=("Malgun Gothic", 10, "bold")).pack(anchor="w", pady=(4, 6))
tk.Label(left_panel, text="현재 선택한 열, 헤더명, 열순서를 그대로 저장합니다.", fg="#444444").pack(anchor="w", pady=(0, 6))

user_preset_buttons = tk.Frame(left_panel)
user_preset_buttons.pack(fill="x", pady=(0, 6))

tk.Label(left_panel, textvariable=preset_var, anchor="w", fg="#0b5c8c").pack(anchor="w", pady=(0, 8))

columns_canvas = tk.Canvas(left_panel, highlightthickness=0)
columns_scrollbar = ttk.Scrollbar(left_panel, orient="vertical", command=columns_canvas.yview)
columns_inner = tk.Frame(columns_canvas)
columns_inner.bind("<Configure>", lambda event: columns_canvas.configure(scrollregion=columns_canvas.bbox("all")))
columns_canvas.create_window((0, 0), window=columns_inner, anchor="nw")
columns_canvas.configure(yscrollcommand=columns_scrollbar.set)
columns_canvas.pack(side="left", fill="both", expand=True)
columns_scrollbar.pack(side="right", fill="y")

tk.Label(right_panel, text="가공 결과 미리보기", font=("Malgun Gothic", 12, "bold")).pack(anchor="w")
tk.Label(
    right_panel,
    text="가공된 전체 컬럼을 먼저 확인한 뒤, 왼쪽에서 필요한 열만 골라 저장하세요.",
    justify="left",
    fg="#444444",
).pack(anchor="w", pady=(4, 10))

preview_frame = tk.Frame(right_panel)
preview_frame.pack(fill="both", expand=True)

preview_tree = ttk.Treeview(preview_frame, show="headings")
preview_scroll_y = ttk.Scrollbar(preview_frame, orient="vertical", command=preview_tree.yview)
preview_scroll_x = ttk.Scrollbar(preview_frame, orient="horizontal", command=preview_tree.xview)
preview_tree.configure(yscrollcommand=preview_scroll_y.set, xscrollcommand=preview_scroll_x.set)

preview_tree.grid(row=0, column=0, sticky="nsew")
preview_scroll_y.grid(row=0, column=1, sticky="ns")
preview_scroll_x.grid(row=1, column=0, sticky="ew")
preview_frame.grid_rowconfigure(0, weight=1)
preview_frame.grid_columnconfigure(0, weight=1)

render_user_preset_buttons()

root.mainloop()
