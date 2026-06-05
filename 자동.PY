import json
import sys
import time
import threading
import ctypes
import pyautogui
import pyperclip
import pandas as pd
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
from openpyxl import load_workbook

pyautogui.FAILSAFE = False

# ==================== 경로 ====================
def get_app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent

def get_bundle_dir():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent

APP_DIR = get_app_dir()
BUNDLE_DIR = get_bundle_dir()
TEMPLATE_PATH = Path(__file__).with_name("자동_템플릿.json")
DEFAULT_TEMPLATE_PATH = BUNDLE_DIR / "자동_템플릿.json"

# ==================== 전역 상태 ====================
excel_path = ""
excel_mode = None          # 'returns' | 'auto_upload' | 'excel3'
excel3_path = ""           # 3번째 엑셀 경로
actions = []               # 현재 액션 목록
is_running = False
stop_requested = threading.Event()
running_action_index = -1

# F4 전역 중지 단축키
WM_HOTKEY = 0x0312
VK_F4 = 0x73
F4_STOP_HOTKEY_ID = 1

# 자동업로드 카테고리 매핑
AUTO_UPLOAD_CATEGORY_KEY = "U_CATEGORY_MAPPED"
AUTO_UPLOAD_CATEGORY_MAP = {
    "라운드니트": "패션의류>여성 패션의류>니트/스웨터>라운드니트",
    "데님 미니 스커트": "패션의류>여성 패션의류>스커트>미니스커트",
    "미니 스커트": "패션의류>여성 패션의류>스커트>미니스커트",
    "베레모": "패션잡화>모자>베레모/헌팅캡",
    "긴소매티셔츠": "패션의류>여성 패션의류>티셔츠>긴소매티셔츠",
    "후드(니트외)": "패션의류>여성 패션의류>후드/맨투맨>후드(니트외)",
    "맨투맨": "패션의류>여성 패션의류>후드/맨투맨>맨투맨/스웨트셔츠",
    "롱팬츠": "패션의류>여성 패션의류>바지>와이드팬츠",
    "블라우스": "패션의류>여성 패션의류>셔츠/남방/블라우스>블라우스",
    "재킷": "패션의류>여성 패션의류>재킷>가죽/스웨이드재킷",
    "가디건": "패션의류>여성 패션의류>가디건",
    "데님 롱팬츠": "패션의류>여성 패션의류>데님/청바지>롱팬츠",
    "미니 원피스": "패션의류>여성 패션의류>원피스>미니원피스",
    "반소매티셔츠": "패션의류>여성 패션의류>티셔츠>반소매티셔츠",
    "반바지": "패션의류>여성 패션의류>바지>반바지",
    "베스트/조끼": "패션의류>여성 패션의류>베스트/조끼>베스트(니트)",
    "코트": "패션의류>여성 패션의류>코트>하프코트",
    "크로스백": "패션잡화>여성신발>단화>로퍼",
    "숄더백": "패션잡화>가방>숄더백",
    "롱원피스": "패션의류>여성 패션의류>원피스>롱원피스",
    "롱스커트": "패션의류>여성 패션의류>스커트>롱스커트",
    "숏팬츠": "패션의류>여성 패션의류>바지>반바지",
    "트레이닝 하의": "패션의류>여성 패션의류>점퍼>바람막이/아노락",
    "미디원피스": "패션의류>여성 패션의류>원피스>미니원피스",
    "반소매원피스": "패션의류>여성 패션의류>원피스>미니원피스",
    "뮬": "패션잡화>여성신발>뮬",
    "미디스커트": "패션의류>여성 패션의류>스커트>미디스커트",
    "데님 숏팬츠": "패션의류>여성 패션의류>데님/청바지>숏팬츠",
    "슬리퍼": "패션잡화>여성신발>부츠>미들부츠",
    "헤어밴드/머리띠": "패션잡화>헤어액세서리>헤어밴드/머리띠",
}

# ==================== 템플릿 I/O ====================
def load_templates() -> dict:
    path = TEMPLATE_PATH if TEMPLATE_PATH.exists() else DEFAULT_TEMPLATE_PATH
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def write_templates(data: dict) -> None:
    TEMPLATE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

# ==================== 액션 유틸 ====================
def unpack_action(action: dict):
    return action.get("type", ""), action.get("value"), action.get("note", "")

def is_first_only_action(action: dict) -> bool:
    return bool(action.get("first_only", False))

def is_after_first_action(action: dict) -> bool:
    return bool(action.get("after_first", False))

def is_option3_only_action(action: dict) -> bool:
    return bool(action.get("option3_only", False))

def is_option3_except_action(action: dict) -> bool:
    return bool(action.get("option3_except", False))

def is_clipboard_starts4_action(action: dict) -> bool:
    return bool(action.get("clipboard_starts4", False))

def build_action(type_: str, value=None, **kwargs) -> dict:
    a = {"type": type_, "value": value}
    for k, v in kwargs.items():
        if v:
            a[k] = v
    return a

def with_action_note(action: dict, note: str) -> dict:
    a = dict(action)
    if note:
        a["note"] = note
    elif "note" in a:
        del a["note"]
    return a

def with_first_only(action: dict, flag: bool) -> dict:
    a = dict(action)
    if flag:
        a["first_only"] = True
    elif "first_only" in a:
        del a["first_only"]
    return a

def with_after_first(action: dict, flag: bool) -> dict:
    a = dict(action)
    if flag:
        a["after_first"] = True
    elif "after_first" in a:
        del a["after_first"]
    return a

def with_option3_only(action: dict, flag: bool) -> dict:
    a = dict(action)
    if flag:
        a["option3_only"] = True
    elif "option3_only" in a:
        del a["option3_only"]
    return a

def with_option3_except(action: dict, flag: bool) -> dict:
    a = dict(action)
    if flag:
        a["option3_except"] = True
    elif "option3_except" in a:
        del a["option3_except"]
    return a

def with_clipboard_starts4(action: dict, flag: bool) -> dict:
    a = dict(action)
    if flag:
        a["clipboard_starts4"] = True
    elif "clipboard_starts4" in a:
        del a["clipboard_starts4"]
    return a

def format_action(action: dict, index: int) -> str:
    act, val, note = unpack_action(action)
    tags = []
    if is_first_only_action(action):
        tags.append("[최초만]")
    if is_after_first_action(action):
        tags.append("[두번째부터]")
    if is_option3_only_action(action):
        tags.append("[옵션3개만]")
    if is_option3_except_action(action):
        tags.append("[옵션3개아님]")
    if is_clipboard_starts4_action(action):
        tags.append("[4부터시작함]")

    labels = {
        "click": lambda v: f"클릭: x={v[0]}, y={v[1]}" if isinstance(v, (list, tuple)) else "클릭",
        "right_click": lambda v: f"우클릭: x={v[0]}, y={v[1]}" if isinstance(v, (list, tuple)) else "우클릭",
        "double_click": lambda v: f"더블클릭: x={v[0]}, y={v[1]}" if isinstance(v, (list, tuple)) else "더블클릭",
        "triple_click": lambda v: f"3번클릭: x={v[0]}, y={v[1]}" if isinstance(v, (list, tuple)) else "3번클릭",
        "key": lambda v: f"키 입력: {v}",
        "paste": lambda v: "붙여넣기",
        "copy": lambda v: "복사(ctrl+c)",
        "auto_copy_col": lambda v: f"{v}열 복사",
        "auto_paste_col": lambda v: f"{v}열 붙여넣기(엑셀쓰기)",
        "skip_if_clipboard_not_equal_col": lambda v: f"클립보드≠{v}열이면 다음행",
        "auto_copy_category_map": lambda v: "카테고리 자동매핑",
        "copy_text": lambda v: f"텍스트복사: {v}",
        "remember_url": lambda v: "URL 기억",
        "check_url_no_change_skip": lambda v: "URL 확인: 변화 없으면 미집화 후 다음행",
        "open_url": lambda v: f"URL 이동: {v}",
        "wait": lambda v: f"대기: {v}초",
        "scroll": lambda v: f"스크롤: {v}",
    }
    base = labels[act](val) if act in labels else f"등록된 액션 {act}"
    parts = [f"{index + 1}. {base}"]
    if tags:
        parts.append(" " + " ".join(tags))
    if note:
        parts.append(f"  # {note}")
    return "".join(parts)

def serialize_action(action: dict) -> dict:
    return dict(action)

def deserialize_action(action: dict) -> dict:
    return dict(action)

# ==================== 자동업로드 CSV 처리 ====================
def read_auto_upload_csv(path: str) -> pd.DataFrame:
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8-sig")
    except UnicodeDecodeError:
        return pd.read_csv(path, dtype=str, encoding="cp949")

def split_option_parts(value) -> list:
    if pd.isna(value) or str(value).strip() == "":
        return []
    return [p.strip() for p in str(value).split("/") if p.strip()]

def join_unique(parts: list) -> str:
    seen = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    return "/".join(seen)

def extract_last_category(value: str) -> str:
    if not value:
        return ""
    parts = value.split(">")
    return parts[-1].strip() if parts else value

def map_auto_upload_category(value: str) -> str:
    if not value:
        return ""
    key = extract_last_category(value.strip())
    return AUTO_UPLOAD_CATEGORY_MAP.get(key, value)

def build_auto_upload_rows(df: pd.DataFrame) -> list:
    if len(df.columns) < 15:
        raise ValueError("자동업로드 CSV에 필요한 B/C/G/O열이 없습니다. 열 개수를 확인하세요.")

    rows = []
    col_b = df.columns[1]
    col_c = df.columns[2]
    col_g = df.columns[6]
    col_m = df.columns[12]
    col_n = df.columns[13]
    col_o = df.columns[14]

    for _, row in df.iterrows():
        c_val = str(row[col_c]).strip() if not pd.isna(row[col_c]) else ""
        if not c_val:
            continue
        b_val = str(row[col_b]).strip() if not pd.isna(row[col_b]) else ""
        g_parts = split_option_parts(row[col_g])
        m_parts = split_option_parts(row[col_m])
        n_parts = split_option_parts(row[col_n])
        o_parts = split_option_parts(row[col_o])

        # 옵션 수 결정
        option_count = max(len(g_parts), 1)
        category = map_auto_upload_category(c_val)

        for i in range(option_count):
            g_val = g_parts[i] if i < len(g_parts) else (g_parts[0] if g_parts else "")
            m_val = m_parts[i] if i < len(m_parts) else (m_parts[0] if m_parts else "")
            n_val = n_parts[i] if i < len(n_parts) else (n_parts[0] if n_parts else "")
            o_val = o_parts[i] if i < len(o_parts) else (o_parts[0] if o_parts else "")

            context = {
                "B": b_val,
                "C": c_val,
                "G": g_val,
                "M": m_val,
                "N": n_val,
                "O": o_val,
                AUTO_UPLOAD_CATEGORY_KEY: category,
            }
            rows.append({"context": context, "option_count": option_count, "b_val": b_val})
    return rows

# ==================== UI 상태 ====================
def set_status(text: str) -> None:
    status_var.set(text)
    root.update_idletasks()

def refresh_action_list() -> None:
    action_listbox.delete(0, tk.END)
    for i, a in enumerate(actions):
        action_listbox.insert(tk.END, format_action(a, i))
    action_count_var.set(f"액션 {len(actions)}개")

def clear_running_highlight() -> None:
    for i in range(action_listbox.size()):
        action_listbox.itemconfig(i, background="", foreground="")

def highlight_running_action(index: int) -> None:
    clear_running_highlight()
    if 0 <= index < action_listbox.size():
        action_listbox.itemconfig(index, background="#dc3545", foreground="white")
        action_listbox.see(index)

# ==================== F4 전역 중지키 ====================
_f4_thread = None

def stop_f4_hotkey_listener():
    global _f4_thread
    try:
        ctypes.windll.user32.UnregisterHotKey(None, F4_STOP_HOTKEY_ID)
    except Exception:
        pass
    _f4_thread = None

def start_f4_hotkey_listener():
    global _f4_thread

    def listen():
        try:
            ok = ctypes.windll.user32.RegisterHotKey(None, F4_STOP_HOTKEY_ID, 0, VK_F4)
            if not ok:
                root.after(0, lambda: set_status(
                    "F4 전역 중지키 등록에 실패했습니다. 중지 버튼은 계속 사용할 수 있습니다."
                ))
            msg = ctypes.wintypes.MSG()
            while is_running:
                if ctypes.windll.user32.PeekMessageW(ctypes.byref(msg), None, WM_HOTKEY, WM_HOTKEY, 1):
                    if msg.message == WM_HOTKEY:
                        stop_macro()
                        break
                time.sleep(0.05)
        except Exception:
            pass
        finally:
            try:
                ctypes.windll.user32.UnregisterHotKey(None, F4_STOP_HOTKEY_ID)
            except Exception:
                pass

    _f4_thread = threading.Thread(target=listen, daemon=True)
    _f4_thread.start()

# ==================== 마우스휠 바인딩 ====================
def bind_mousewheel(widget):
    def on_mousewheel(event):
        if event.delta:
            widget.yview_scroll(int(-1 * event.delta / 120), "units")
        elif event.num == 4:
            widget.yview_scroll(-1, "units")
        elif event.num == 5:
            widget.yview_scroll(1, "units")
    widget.bind("<MouseWheel>", on_mousewheel)
    widget.bind("<Button-4>", on_mousewheel)
    widget.bind("<Button-5>", on_mousewheel)

# ==================== 템플릿 관리 ====================
def refresh_template_options():
    templates = load_templates()
    names = list(templates.keys())
    template_combo["values"] = names
    after_template_combo["values"] = ["(없음)"] + names
    final_template_combo["values"] = ["(없음)"] + names
    if template_var.get() not in names:
        template_var.set(names[0] if names else "")
    if after_template_var.get() not in ["(없음)"] + names:
        after_template_var.set("(없음)")
    if final_template_var.get() not in ["(없음)"] + names:
        final_template_var.set("(없음)")

def save_template():
    if not actions:
        messagebox.showwarning("확인 필요", "저장할 액션을 먼저 추가하세요.")
        return
    name = simpledialog.askstring("템플릿 저장", "템플릿 이름을 입력하세요.", parent=root)
    if name is None:
        return
    name = name.strip()
    if not name:
        return
    templates = load_templates()
    if name in templates:
        if not messagebox.askyesno("덮어쓰기", f"'{name}' 템플릿을 덮어쓸까요?"):
            return
    templates[name] = [serialize_action(a) for a in actions]
    write_templates(templates)
    refresh_template_options()
    template_var.set(name)
    set_status(f"'{name}' 템플릿을 저장했습니다.")

def save_selected_template():
    if not actions:
        messagebox.showwarning("확인 필요", "저장할 액션을 먼저 추가하세요.")
        return
    name = template_var.get().strip()
    if not name:
        messagebox.showwarning("확인 필요", "저장할 템플릿을 선택하세요.")
        return
    templates = load_templates()
    if name not in templates:
        messagebox.showerror("템플릿 오류", "선택한 템플릿을 찾을 수 없습니다.")
        return
    if not messagebox.askyesno("선택 템플릿 저장", f"'{name}' 템플릿에 현재 액션을 저장할까요?"):
        return
    templates[name] = [serialize_action(a) for a in actions]
    write_templates(templates)
    refresh_template_options()
    template_var.set(name)
    set_status(f"'{name}' 템플릿에 현재 액션을 저장했습니다.")

def load_template():
    name = template_var.get().strip()
    if not name:
        messagebox.showwarning("확인 필요", "불러올 템플릿을 선택하세요.")
        return
    templates = load_templates()
    if name not in templates:
        messagebox.showerror("템플릿 오류", "선택한 템플릿을 찾을 수 없습니다.")
        return
    try:
        loaded = [deserialize_action(a) for a in templates[name]]
    except Exception as exc:
        messagebox.showerror("템플릿 오류", f"템플릿을 불러올 수 없습니다.\n{exc}")
        return
    actions.clear()
    actions.extend(loaded)
    refresh_action_list()
    set_status(f"'{name}' 템플릿을 불러왔습니다.")

def delete_template():
    name = template_var.get().strip()
    if not name:
        messagebox.showwarning("확인 필요", "삭제할 템플릿을 선택하세요.")
        return
    if not messagebox.askyesno("템플릿 삭제", f"'{name}' 템플릿을 삭제할까요?"):
        return
    templates = load_templates()
    if name in templates:
        del templates[name]
        write_templates(templates)
    refresh_template_options()
    set_status(f"'{name}' 템플릿을 삭제했습니다.")

# ==================== 파일 선택 ====================
def _cell_value_to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()

def write_c_prefixed_e_to_at_column(path: str) -> int:
    wb = load_workbook(path)
    ws = wb.active
    changed = 0
    for row_idx in range(2, ws.max_row + 1):
        source = ws.cell(row=row_idx, column=5)
        target = ws.cell(row=row_idx, column=46)
        text = _cell_value_to_text(source.value)
        if not text:
            continue
        target.value = text if text.upper().startswith("C") else f"C{text}"
        changed += 1
    wb.save(path)
    return changed

def preprocess_exchange_return_invoice(path: str) -> int:
    wb = load_workbook(path)
    ws = wb.active
    changed = 0
    for row_idx in range(2, ws.max_row + 1):
        source = ws.cell(row=row_idx, column=5)
        text = _cell_value_to_text(source.value)
        if not text:
            continue
        ws.cell(row=row_idx, column=23).value = "롯데택배"
        ws.cell(row=row_idx, column=24).value = 5
        ws.cell(row=row_idx, column=46).value = text if text.upper().startswith("C") else f"C{text}"
        changed += 1
    wb.save(path)
    return changed

def select_exchange_invoice_file():
    global excel3_path, excel_mode
    selected = filedialog.askopenfilename(
        title="교환송장등록 엑셀선택",
        filetypes=[("Excel files", "*.xlsx *.xlsm")],
    )
    if not selected:
        return
    try:
        changed = write_c_prefixed_e_to_at_column(selected)
    except Exception as exc:
        messagebox.showerror("오류", f"교환송장등록 엑셀 처리 실패\n{exc}")
        return
    excel3_path = selected
    excel_mode = "excel3"
    file_label.config(text=f"[교환송장등록] {Path(selected).name}", fg="#0d6efd")
    set_status(f"교환송장등록 파일을 선택했습니다. E열 기준 AT열 {changed}건을 작성했고, 행 수만큼 반복합니다.")

def select_file():
    global excel_path, excel_mode
    selected = filedialog.askopenfilename(
        title="반품 자동화 엑셀 선택",
        filetypes=[("Excel files", "*.xlsx *.xls *.xlsm")],
    )
    if not selected:
        return
    excel_path = selected
    excel_mode = "returns"
    file_label.config(text=f"[반품] {Path(selected).name}", fg="#0b5c8c")
    set_status("반품 자동화 엑셀을 선택했습니다.")

def select_auto_upload_file():
    global excel_path, excel_mode
    selected = filedialog.askopenfilename(
        title="자동업로드 CSV 선택",
        filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
    )
    if not selected:
        return
    excel_path = selected
    excel_mode = "auto_upload"
    file_label.config(text=f"[자동업로드 CSV] {Path(selected).name}", fg="#5c0b8c")
    set_status("자동업로드 CSV를 선택했습니다. C열 2행부터 반복합니다.")

def select_excel3_file():
    global excel3_path, excel_mode
    selected = filedialog.askopenfilename(
        title="3번째 엑셀 선택",
        filetypes=[("Excel/CSV files", "*.xlsx *.xls *.xlsm *.csv")],
    )
    if not selected:
        return
    changed = None
    if Path(selected).suffix.lower() != ".csv":
        try:
            changed = preprocess_exchange_return_invoice(selected)
        except Exception as exc:
            messagebox.showerror("오류", f"교환회수송장등록 엑셀 처리 실패\n{exc}")
            return
    excel3_path = selected
    excel_mode = "excel3"
    file_label.config(text=f"[3번째 엑셀] {Path(selected).name}", fg="#0b8c3a")
    suffix_msg = f" E열 기준 W/X/AT열 {changed}건을 작성했습니다." if changed is not None else ""
    set_status(f"교환회수송장등록 파일을 선택했습니다.{suffix_msg} 행 수만큼 반복합니다.")

# ==================== 엑셀3 로딩 ====================
def load_excel3_df(path: str) -> pd.DataFrame:
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".csv":
        try:
            return pd.read_csv(path, dtype=str, encoding="utf-8-sig")
        except UnicodeDecodeError:
            return pd.read_csv(path, dtype=str, encoding="cp949")
    return pd.read_excel(path, dtype=str)

def _col_letter_to_idx(col_letter: str) -> int:
    col_letter = col_letter.upper().strip()
    idx = 0
    for ch in col_letter:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1

def apply_excel_filter(df: pd.DataFrame) -> pd.DataFrame:
    if not filter_enabled_var.get():
        return df
    col_letter = filter_col_var.get().strip().upper()
    if not col_letter:
        return df
    col_idx = _col_letter_to_idx(col_letter)
    if col_idx >= len(df.columns):
        return df
    col_name = df.columns[col_idx]
    series = df[col_name].fillna("").astype(str)
    text = filter_text_var.get().strip()
    startswith = filter_startswith_var.get().strip()
    if not text and not startswith:
        return df
    mask = pd.Series([True] * len(df), index=df.index)
    if text:
        mask &= series.str.contains(text, case=False, na=False)
    if startswith:
        mask &= series.str.startswith(startswith)
    return df[mask]

def build_excel3_context(row: pd.Series) -> dict:
    context = {}
    for i, val in enumerate(row):
        col_letter = chr(ord("A") + i) if i < 26 else f"A{chr(ord('A') + i - 26)}"
        context[col_letter] = "" if pd.isna(val) else str(val).strip()
    return context

# ==================== 액션 추가 함수들 ====================
def add_action(action: dict) -> None:
    sel = action_listbox.curselection()
    insert_at = sel[-1] + 1 if sel else len(actions)
    actions.insert(insert_at, action)
    refresh_action_list()
    action_listbox.selection_clear(0, tk.END)
    action_listbox.selection_set(insert_at)

def add_click():
    def capture():
        time.sleep(2)
        x, y = pyautogui.position()
        a = build_action("click", [x, y])
        root.after(0, lambda: (add_action(a), set_status(f"클릭 위치를 저장했습니다. x={x}, y={y}")))
    set_status("2초 뒤 현재 마우스 위치를 클릭 액션으로 저장합니다.")
    threading.Thread(target=capture, daemon=True).start()

def add_double_click():
    def capture():
        time.sleep(2)
        x, y = pyautogui.position()
        a = build_action("double_click", [x, y])
        root.after(0, lambda: (add_action(a), set_status(f"더블클릭 위치를 저장했습니다. x={x}, y={y}")))
    set_status("2초 뒤 현재 마우스 위치를 더블클릭 액션으로 저장합니다.")
    threading.Thread(target=capture, daemon=True).start()

def add_triple_click():
    def capture():
        time.sleep(2)
        x, y = pyautogui.position()
        a = build_action("triple_click", [x, y])
        root.after(0, lambda: (add_action(a), set_status(f"3번클릭 위치를 저장했습니다. x={x}, y={y}")))
    set_status("2초 뒤 현재 마우스 위치를 3번클릭 액션으로 저장합니다.")
    threading.Thread(target=capture, daemon=True).start()

def add_right_click():
    def capture():
        time.sleep(2)
        x, y = pyautogui.position()
        a = build_action("right_click", [x, y])
        root.after(0, lambda: (add_action(a), set_status(f"우클릭 위치를 저장했습니다. x={x}, y={y}")))
    set_status("2초 뒤 현재 마우스 위치를 우클릭 액션으로 저장합니다.")
    threading.Thread(target=capture, daemon=True).start()

def normalize_key_name(key: str) -> str:
    mapping = {
        "Return": "enter", "Escape": "esc", "BackSpace": "backspace",
        "Delete": "delete", "Insert": "insert", "Prior": "pageup",
        "Next": "pagedown", "Home": "home", "End": "end",
        "Down": "down", "Up": "up", "Left": "left", "Right": "right",
        "Tab": "tab", "space": "space", "F1": "f1", "F2": "f2",
        "F3": "f3", "F4": "f4", "F5": "f5", "F6": "f6",
        "F7": "f7", "F8": "f8", "F9": "f9", "F10": "f10",
        "F11": "f11", "F12": "f12",
    }
    return mapping.get(key, key.lower())

_MODIFIER_KEYS = {"ctrl", "alt", "shift", "win", "command"}

def run_key_action(combo: str):
    """
    지원 형식:
      "enter"          → press("enter")
      "alt+tab"        → hotkey("alt", "tab")  (Alt 눌렀다 뗌)
      "tab*3"          → press("tab") × 3
      "alt+tab*3"      → keyDown("alt") → press("tab") × 3 → keyUp("alt")
                         (Alt 누른 채 Tab 3번 — 창 전환 3칸)
    """
    if "*" in combo:
        parts = combo.split("*")
        base = parts[0].strip()
        repeat = int(parts[1].strip()) if len(parts) > 1 else 1

        keys = [k.strip() for k in base.split("+")]
        mods    = [k for k in keys if k in _MODIFIER_KEYS]
        actions = [k for k in keys if k not in _MODIFIER_KEYS]

        if mods and actions:
            # 수식키는 누른 채 유지, 나머지 키만 repeat번 반복
            for m in mods:
                pyautogui.keyDown(m)
            try:
                for _ in range(repeat):
                    for k in actions:
                        pyautogui.press(k)
            finally:
                for m in reversed(mods):
                    pyautogui.keyUp(m)
        else:
            # 수식키 없이 전체 조합을 repeat번 반복
            for _ in range(repeat):
                run_key_action(base)
        return

    keys = [k.strip() for k in combo.split("+")]
    if len(keys) == 1:
        pyautogui.press(keys[0])   # 단일 키
    else:
        pyautogui.hotkey(*keys)    # 조합 키

def add_key():
    dialog = tk.Toplevel(root)
    dialog.title("키 입력 등록")
    dialog.geometry("400x310")
    dialog.grab_set()

    combo_var = tk.StringVar()

    def confirm_with(val=None):
        v = val if val is not None else combo_var.get().strip()
        if v:
            add_action(build_action("key", v))
            set_status(f"키 입력: {v}")
        dialog.destroy()

    # ── 자주 쓰는 키 버튼 ──
    tk.Label(dialog, text="자주 쓰는 키", font=("Malgun Gothic", 9, "bold")).pack(anchor="w", padx=14, pady=(12, 4))

    preset_frame = tk.Frame(dialog)
    preset_frame.pack(fill="x", padx=14, pady=(0, 8))

    presets = [
        ("Enter", "enter"), ("Tab", "tab"), ("Esc", "esc"),
        ("Backspace", "backspace"), ("Delete", "delete"), ("Space", "space"),
        ("↑", "up"), ("↓", "down"), ("←", "left"), ("→", "right"),
        ("F5", "f5"), ("F12", "f12"),
    ]
    for col, (label, key) in enumerate(presets):
        tk.Button(
            preset_frame, text=label, width=7,
            command=lambda k=key: confirm_with(k),
        ).grid(row=col // 6, column=col % 6, padx=2, pady=2)

    # ── 직접 입력 ──
    tk.Label(dialog, text="직접 입력 (예: alt+tab, ctrl+c, alt+tab*3)").pack(anchor="w", padx=14, pady=(4, 2))
    entry = tk.Entry(dialog, textvariable=combo_var, width=32)
    entry.pack(padx=14, pady=(0, 6))
    entry.bind("<Return>", lambda e: confirm_with())

    # ── 키보드 캡처 ──
    tk.Label(dialog, text="또는 키보드로 직접 눌러서 등록:").pack(anchor="w", padx=14, pady=(2, 2))
    record_entry = tk.Entry(dialog, width=32)
    record_entry.pack(padx=14, pady=(0, 8))

    def on_key_press(event):
        mods = []
        if event.state & 0x4:
            mods.append("ctrl")
        if event.state & 0x8:
            mods.append("alt")
        if event.state & 0x1:
            mods.append("shift")
        key = normalize_key_name(event.keysym)
        if key not in mods:
            mods.append(key)
        combo_var.set("+".join(mods))

    record_entry.bind("<KeyPress>", on_key_press)

    tk.Button(dialog, text="추가", command=lambda: confirm_with(), width=10).pack(pady=4)

def add_paste():
    add_action(build_action("paste"))
    set_status("붙여넣기 액션 추가")

def add_copy():
    add_action(build_action("copy"))
    set_status("복사(ctrl+c) 액션 추가")

def add_auto_copy_col():
    col = simpledialog.askstring("열 복사", "복사할 열 이름을 입력하세요 (예: A, B, C):", parent=root)
    if col is None:
        return
    col = col.strip().upper()
    if not col:
        return
    add_action(build_action("auto_copy_col", col))
    set_status(f"열 복사 액션 추가: {col}열")

def add_auto_paste_col():
    col = simpledialog.askstring(
        "열 붙여넣기",
        "클립보드 내용을 붙여넣을 열 이름을 입력하세요 (예: A, B, C):\n"
        "(실행 중인 행의 해당 열에 클립보드 값을 기록합니다)",
        parent=root,
    )
    if col is None:
        return
    col = col.strip().upper()
    if not col:
        return
    add_action(build_action("auto_paste_col", col))
    set_status(f"열 붙여넣기 액션 추가: {col}열")

def add_skip_if_clipboard_not_equal_col():
    col = simpledialog.askstring(
        "클립보드 열 비교",
        "클립보드 값과 비교할 현재 행의 열 이름을 입력하세요. (예: A, B, C):",
        parent=root,
    )
    if col is None:
        return
    col = col.strip().upper()
    if not col:
        return
    add_action(build_action("skip_if_clipboard_not_equal_col", col))
    set_status(f"클립보드와 {col}열이 다르면 다음 행으로 넘어가는 액션 추가")

def add_auto_copy_category_map():
    add_action(build_action("auto_copy_category_map"))
    set_status("카테고리 자동매핑 액션 추가")

def add_copy_text():
    text = simpledialog.askstring("텍스트 복사", "복사할 텍스트를 입력하세요:", parent=root)
    if text is None:
        return
    add_action(build_action("copy_text", text))
    set_status(f"텍스트복사 액션 추가: {text}")

def add_remember_url():
    add_action(build_action("remember_url"))
    set_status("URL 기억 액션 추가")

def add_check_url_no_change_skip():
    add_action(build_action("check_url_no_change_skip"))
    set_status("URL 변화 확인 액션 추가")

def add_open_url():
    url = simpledialog.askstring("URL 이동", "이동할 URL을 입력하세요:", parent=root)
    if url is None:
        return
    add_action(build_action("open_url", url))
    set_status(f"URL 이동 액션 추가: {url}")

def add_wait():
    val = simpledialog.askfloat("대기", "대기 시간(초)를 입력하세요:", parent=root, minvalue=0.1)
    if val is None:
        return
    add_action(build_action("wait", val))
    set_status(f"대기 액션 추가: {val}초")

def add_scroll():
    val = simpledialog.askinteger("스크롤", "스크롤 값을 입력하세요 (음수=내리기, 양수=올리기):", parent=root)
    if val is None:
        return
    add_action(build_action("scroll", val))
    set_status(f"스크롤 액션 추가: {val}")

# ==================== 액션 목록 관리 ====================
def delete_selected_action():
    sel = action_listbox.curselection()
    if not sel:
        return
    for i in reversed(sel):
        del actions[i]
    refresh_action_list()
    new_sel = min(sel[0], len(actions) - 1)
    if new_sel >= 0:
        action_listbox.selection_set(new_sel)

def clear_actions():
    if not actions:
        return
    if not messagebox.askyesno("초기화", "모든 액션을 삭제할까요?"):
        return
    actions.clear()
    refresh_action_list()

def move_selected_action(delta: int):
    sel = action_listbox.curselection()
    if not sel:
        return
    idx = sel[0]
    target = idx + delta
    if target < 0 or target >= len(actions):
        return
    actions[idx], actions[target] = actions[target], actions[idx]
    refresh_action_list()
    action_listbox.selection_set(target)

def _toggle_action_flag(attr: str, setter):
    sel = action_listbox.curselection()
    if not sel:
        return
    idx = sel[0]
    current = actions[idx].get(attr, False)
    actions[idx] = setter(actions[idx], not current)
    refresh_action_list()
    action_listbox.selection_set(idx)

def toggle_first_only_action():
    _toggle_action_flag("first_only", with_first_only)

def toggle_after_first_action():
    _toggle_action_flag("after_first", with_after_first)

def toggle_option3_only_action():
    _toggle_action_flag("option3_only", with_option3_only)

def toggle_option3_except_action():
    _toggle_action_flag("option3_except", with_option3_except)

def toggle_clipboard_starts4_action():
    _toggle_action_flag("clipboard_starts4", with_clipboard_starts4)

def edit_action_note():
    sel = action_listbox.curselection()
    if not sel:
        return
    idx = sel[0]
    current_note = actions[idx].get("note", "")
    note = simpledialog.askstring("메모 편집", "메모를 입력하세요:", initialvalue=current_note, parent=root)
    if note is None:
        return
    actions[idx] = with_action_note(actions[idx], note.strip())
    refresh_action_list()
    action_listbox.selection_set(idx)

# ==================== 실행 ====================
def validate_before_start() -> bool:
    if not actions:
        messagebox.showwarning("확인 필요", "저장할 액션을 먼저 추가하세요.")
        return False
    return True

def set_running_state(running: bool):
    global is_running
    is_running = running
    state = tk.DISABLED if running else tk.NORMAL
    start_button.config(state=state)
    start_selected_button.config(state=state)
    start_one_button.config(state=state)
    stop_button.config(state=tk.NORMAL if running else tk.DISABLED)
    if not running:
        stop_requested.clear()
        clear_running_highlight()
        stop_f4_hotkey_listener()

def stop_macro():
    stop_requested.set()
    set_status("중지 요청 중...")

def sleep_with_stop(seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        if stop_requested.is_set():
            return
        time.sleep(0.05)

def get_current_url() -> str:
    """Ctrl+L로 주소창 포커스 → Ctrl+A/C로 URL 복사 → 클립보드에서 읽기."""
    try:
        old_clip = pyperclip.paste()
        pyautogui.hotkey("ctrl", "l")   # 주소창 포커스
        time.sleep(0.3)
        pyautogui.hotkey("ctrl", "a")   # 전체 선택
        pyautogui.hotkey("ctrl", "c")   # URL 복사
        time.sleep(0.2)
        url = pyperclip.paste()
        pyautogui.press("escape")       # 포커스 복원
        time.sleep(0.1)
        pyperclip.copy(old_clip)        # 클립보드 복원
        return url.strip()
    except Exception:
        return ""

def open_url(url: str):
    import webbrowser
    webbrowser.open(url)
    time.sleep(1)

def start_macro(start_from_selected: bool = False, selected_only: bool = False):
    global running_action_index
    if not validate_before_start():
        return

    # 시작 액션 인덱스
    start_action_index = 0
    if start_from_selected:
        sel = action_listbox.curselection()
        start_action_index = sel[0] if sel else 0

    action_snapshot = list(actions[start_action_index:] if start_from_selected else actions)
    if selected_only:
        sel = action_listbox.curselection()
        if not sel:
            messagebox.showwarning("확인 필요", "저장된 액션을 먼저 선택하세요.")
            return
        action_snapshot = [actions[i] for i in sel]

    # 딜레이 읽기
    try:
        delay = float(delay_entry.get())
    except Exception:
        delay = 0.0

    # 반복 수 (엑셀 없는 경우)
    try:
        repeat_count = int(selected_count_entry.get())
        if repeat_count < 1:
            repeat_count = 1
    except Exception:
        repeat_count = 1

    # 시작 행 (엑셀 모드) — 1 이상, 1이면 첫 행부터
    try:
        start_row = max(1, int(start_row_entry.get()))
    except Exception:
        start_row = 1

    # 템플릿 로드
    templates = load_templates()
    after_name = after_template_var.get().strip()
    final_name = final_template_var.get().strip()

    after_action_snapshot = []
    if after_name and after_name != "(없음)" and after_name in templates:
        try:
            after_action_snapshot = [deserialize_action(a) for a in templates[after_name]]
        except Exception as exc:
            messagebox.showerror("템플릿 오류", f"완료 후 실행 템플릿을 불러올 수 없습니다.\n{exc}")
            return

    final_action_snapshot = []
    if final_name and final_name != "(없음)" and final_name in templates:
        try:
            final_action_snapshot = [deserialize_action(a) for a in templates[final_name]]
        except Exception as exc:
            messagebox.showerror("템플릿 오류", f"상품준비 반복 템플릿을 불러올 수 없습니다.\n{exc}")
            return

    # run_actions 클로저에서 참조하는 공유 상태
    auto_upload_context = {}
    excel_col_writer = None  # 현재 행에 값을 기록하는 콜백 (auto_paste_col용)

    def run_actions(action_list, first_repeat: bool, option_count: int):
        remembered_url = ""   # 호출마다 초기화 — 행 간 URL 오염 방지
        for i_a, action in enumerate(action_list):
            act, val, _ = unpack_action(action)

            if stop_requested.is_set():
                return "stop"

            if is_first_only_action(action) and not first_repeat:
                continue
            if is_after_first_action(action) and first_repeat:
                continue
            if is_option3_only_action(action) and option_count != 3:
                continue
            if is_option3_except_action(action) and option_count == 3:
                continue
            if is_clipboard_starts4_action(action):
                if not str(pyperclip.paste() or "").strip().startswith("4"):
                    continue

            if act == "click":
                pyautogui.click(val)
            elif act == "right_click":
                pyautogui.click(val, button="right")
            elif act == "double_click":
                pyautogui.doubleClick(val)
            elif act == "triple_click":
                pyautogui.click(val, clicks=3, interval=0.1)
            elif act == "key":
                run_key_action(val)
            elif act == "paste":
                pyautogui.hotkey("ctrl", "v")
            elif act == "copy":
                pyautogui.hotkey("ctrl", "c")
            elif act == "copy_text":
                pyperclip.copy(str(val) if val is not None else "")
            elif act == "auto_copy_col":
                pyperclip.copy(str(auto_upload_context.get(val, "")))
            elif act == "auto_paste_col":
                col = str(val).strip().upper() if val else ""
                if col:
                    clip_val = pyperclip.paste()
                    auto_upload_context[col] = clip_val
                    if excel_col_writer is not None:
                        excel_col_writer(col, clip_val)
            elif act == "skip_if_clipboard_not_equal_col":
                col = str(val).strip().upper() if val else ""
                clip_val = str(pyperclip.paste() or "").strip()
                row_val = str(auto_upload_context.get(col, "") or "").strip()
                if clip_val != row_val:
                    return "skip_row"
            elif act == "auto_copy_category_map":
                pyperclip.copy(str(auto_upload_context.get(AUTO_UPLOAD_CATEGORY_KEY, "")))
            elif act == "remember_url":
                remembered_url = get_current_url()
            elif act == "check_url_no_change_skip":
                current_url = get_current_url()
                if remembered_url and current_url == remembered_url:
                    return "url_no_change"
            elif act == "open_url":
                open_url(str(val) if val else "")
            elif act == "wait":
                sleep_with_stop(float(val) if val else 0)
            elif act == "scroll":
                pyautogui.scroll(int(val) if val else 0)
            else:
                pass

            sleep_with_stop(delay)

        return "ok"

    def run():
        nonlocal auto_upload_context, excel_col_writer
        try:
            # ---- 엑셀 없이 실행 ----
            if not excel_path and not excel3_path:
                if len(action_snapshot) == 1 and selected_only:
                    root.after(0, lambda: set_status("한 액션만 실행 모드입니다."))
                else:
                    root.after(0, lambda: set_status("엑셀 없이 등록된 액션을 1회 실행 중입니다."))
                result = run_actions(action_snapshot, True, 1)
                if result == "stop":
                    root.after(0, lambda: set_status("자동화를 중지했습니다."))
                    return
                root.after(0, lambda: set_status("자동화가 완료되었습니다."))
                root.after(0, lambda: messagebox.showinfo("완료", "자동화가 완료되었습니다."))
                return

            # ---- excel3 모드 ----
            if excel_mode == "excel3" and excel3_path:
                df3 = load_excel3_df(excel3_path)
                df3 = apply_excel_filter(df3)
                # reset_index 하지 않아 orig_idx로 엑셀 원본 행 번호 추적
                total = len(df3)
                root.after(0, lambda: set_status(f"3번째 엑셀 자동화 시작: 총 {total}행"))

                # 쓰기 가능한 경우 workbook 로드
                wb3, ws3 = None, None
                if not excel3_path.lower().endswith(".csv"):
                    try:
                        wb3 = load_workbook(excel3_path)
                        ws3 = wb3.active
                    except Exception:
                        pass

                first_executed = True
                for i, (orig_idx, row) in enumerate(df3.iterrows()):
                    if stop_requested.is_set():
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        return
                    if i < start_row - 1:
                        continue

                    # orig_idx(0-based pandas) + 2 = openpyxl 행 번호(헤더=1행)
                    openpyxl_row3 = orig_idx + 2

                    def _make_writer3(orow):
                        def _write(col_letter, value):
                            if ws3 is not None:
                                ws3.cell(row=orow,
                                         column=_col_letter_to_idx(col_letter) + 1).value = value
                                wb3.save(excel3_path)
                        return _write

                    excel_col_writer = _make_writer3(openpyxl_row3)
                    auto_upload_context = build_excel3_context(row)
                    first_rep = first_executed
                    first_executed = False
                    n = i + 1
                    root.after(0, lambda n=n, total=total: set_status(f"3번째 엑셀 {n}/{total} 행 실행 중"))
                    root.after(0, lambda n=n: highlight_running_action(0))

                    result = run_actions(action_snapshot, first_rep, 1)
                    if result == "skip_row":
                        root.after(0, lambda n=n: set_status(f"{n}행 비교 불일치: 다음 행으로 이동"))
                        sleep_with_stop(0.3)
                        continue
                    if result == "stop":
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        return
                    if result == "url_no_change":
                        if ws3 is not None:
                            ws3.cell(row=openpyxl_row3, column=30).value = "미집화"  # AD열
                            wb3.save(excel3_path)
                        root.after(0, lambda n=n: set_status(f"{n}행 URL 변화 없음: AD열에 미집화 기록"))
                        sleep_with_stop(0.3)
                        continue

                    if after_action_snapshot:
                        root.after(0, lambda n=n: set_status(f"완료 후 템플릿 실행 중: {n}행"))
                        r2 = run_actions(after_action_snapshot, first_rep, 1)
                        if r2 == "stop":
                            root.after(0, lambda: set_status("자동화를 중지했습니다."))
                            return

                if final_action_snapshot:
                    root.after(0, lambda: set_status("마무리 템플릿 실행 중"))
                    run_actions(final_action_snapshot, True, 1)

                root.after(0, lambda: set_status("자동화가 완료되었습니다."))
                root.after(0, lambda: messagebox.showinfo("완료", "자동화가 완료되었습니다."))
                return

            # ---- auto_upload 모드 ----
            if excel_mode == "auto_upload" and excel_path:
                df = read_auto_upload_csv(excel_path)
                df = apply_excel_filter(df)
                rows = build_auto_upload_rows(df)
                total = len(rows)
                root.after(0, lambda: set_status(f"자동업로드 자동화 시작: 총 {total}건"))

                first_executed = True
                for i, row_info in enumerate(rows):
                    if stop_requested.is_set():
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        return
                    if i < start_row - 1:
                        continue

                    auto_upload_context = row_info["context"]
                    opt_count = row_info["option_count"]
                    b_val = row_info["b_val"]
                    first_rep = first_executed
                    first_executed = False
                    n = i + 1
                    root.after(0, lambda n=n, total=total, b=b_val: set_status(
                        f"자동업로드 {n}/{total} 작업 중: B={b}"
                    ))
                    root.after(0, lambda: highlight_running_action(0))

                    result = run_actions(action_snapshot, first_rep, opt_count)
                    if result == "skip_row":
                        root.after(0, lambda n=n: set_status(f"{n}행 비교 불일치: 다음 행으로 이동"))
                        sleep_with_stop(0.3)
                        continue
                    if result == "stop":
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        return
                    if result == "url_no_change":
                        root.after(0, lambda n=n: set_status(f"{n}행 URL 변화 없음: 미집화"))
                        sleep_with_stop(0.3)
                        continue

                    if after_action_snapshot:
                        root.after(0, lambda n=n: set_status(f"완료 후 템플릿 실행 중: {n}행"))
                        r2 = run_actions(after_action_snapshot, first_rep, opt_count)
                        if r2 == "stop":
                            root.after(0, lambda: set_status("자동화를 중지했습니다."))
                            return

                if final_action_snapshot:
                    root.after(0, lambda: set_status("마무리 템플릿 실행 중"))
                    run_actions(final_action_snapshot, True, 1)

                root.after(0, lambda: set_status("자동화가 완료되었습니다."))
                root.after(0, lambda: messagebox.showinfo("완료", "자동화가 완료되었습니다."))
                return

            # ---- returns 모드 ----
            if excel_mode == "returns" and excel_path:
                wb = load_workbook(excel_path)
                ws = wb.active
                # pandas로 읽어서 필터 적용 후 원본 행 번호 추적
                df_ret = pd.read_excel(excel_path, dtype=str)
                df_ret = apply_excel_filter(df_ret)
                total = len(df_ret)
                root.after(0, lambda: set_status(f"반품 자동화 시작: 총 {total}행"))

                first_executed = True
                for i, (orig_idx, pd_row) in enumerate(df_ret.iterrows()):
                    if stop_requested.is_set():
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        break
                    if i < start_row - 1:
                        continue

                    # orig_idx는 0-기반 → openpyxl 행 번호 = orig_idx + 2
                    openpyxl_row = orig_idx + 2

                    def _make_writer_ret(orow):
                        def _write(col_letter, value):
                            ws.cell(row=orow,
                                    column=_col_letter_to_idx(col_letter) + 1).value = value
                            wb.save(excel_path)
                        return _write

                    excel_col_writer = _make_writer_ret(openpyxl_row)
                    auto_upload_context = {}
                    for ci, cell_val in enumerate(pd_row):
                        col_letter = chr(ord("A") + ci) if ci < 26 else f"A{chr(ord('A') + ci - 26)}"
                        auto_upload_context[col_letter] = "" if pd.isna(cell_val) else str(cell_val).strip()

                    first_rep = first_executed
                    first_executed = False
                    n = i + 1
                    root.after(0, lambda n=n, total=total: set_status(f"반품 자동화 {n}/{total} 행 실행 중"))
                    root.after(0, lambda: highlight_running_action(0))

                    result = run_actions(action_snapshot, first_rep, 1)
                    if result == "skip_row":
                        root.after(0, lambda n=n: set_status(f"{n}행 비교 불일치: 다음 행으로 이동"))
                        sleep_with_stop(0.3)
                        continue
                    if result == "stop":
                        root.after(0, lambda: set_status("자동화를 중지했습니다."))
                        break
                    if result == "url_no_change":
                        ws.cell(row=openpyxl_row, column=30).value = "미집화"  # AD열
                        wb.save(excel_path)
                        root.after(0, lambda n=n: set_status(f"{n}행 URL 변화 없음: AD열에 미집화 기록"))
                        sleep_with_stop(0.3)
                        continue

                    ws.cell(row=openpyxl_row, column=7).value = "사입"
                    wb.save(excel_path)

                    if after_action_snapshot:
                        root.after(0, lambda n=n: set_status(f"완료 후 템플릿 실행 중: {n}행"))
                        r2 = run_actions(after_action_snapshot, first_rep, 1)
                        if r2 == "stop":
                            root.after(0, lambda: set_status("자동화를 중지했습니다."))
                            break

                if final_action_snapshot:
                    root.after(0, lambda: set_status("마무리 템플릿 실행 중"))
                    run_actions(final_action_snapshot, True, 1)

                root.after(0, lambda: set_status("자동화가 완료되었습니다."))
                root.after(0, lambda: messagebox.showinfo("완료", "자동화가 완료되었습니다."))
                return

        except Exception as exc:
            root.after(0, lambda exc=exc: (
                set_status(f"오류가 발생했습니다."),
                messagebox.showerror("오류", str(exc))
            ))
        finally:
            root.after(0, lambda: set_running_state(False))

    stop_requested.clear()
    set_running_state(True)
    start_f4_hotkey_listener()
    threading.Thread(target=run, daemon=True).start()

# ==================== 메인 창 스크롤 ====================
def update_main_scrollregion(event=None):
    content_canvas.configure(scrollregion=content_canvas.bbox("all"))

def resize_main_width(event=None):
    content_canvas.itemconfig(main_window, width=content_canvas.winfo_width())

# ==================== UI 구성 ====================
root = tk.Tk()
root.title("유세크 자동화")
root.geometry("900x780")
root.minsize(700, 600)

style = ttk.Style()
style.configure("TCombobox", padding=2)

# 스크롤 가능한 메인 영역
content_frame = tk.Frame(root)
content_frame.pack(fill=tk.BOTH, expand=True)
content_frame.columnconfigure(0, weight=1)
content_frame.rowconfigure(0, weight=1)

content_canvas = tk.Canvas(content_frame, highlightthickness=0)
content_canvas.grid(row=0, column=0, sticky="nsew")

content_scrollbar = ttk.Scrollbar(content_frame, orient=tk.VERTICAL, command=content_canvas.yview)
content_scrollbar.grid(row=0, column=1, sticky="ns")
content_canvas.configure(yscrollcommand=content_scrollbar.set)

main = tk.Frame(content_canvas, padx=14, pady=10)
main_window = content_canvas.create_window((0, 0), window=main, anchor="nw")
main.bind("<Configure>", update_main_scrollregion)
content_canvas.bind("<Configure>", resize_main_width)
bind_mousewheel(content_canvas)

# ---- 파일 선택 영역 ----
file_frame = tk.LabelFrame(main, text="엑셀 파일 선택", padx=8, pady=8)
file_frame.pack(fill="x", pady=(0, 8))

btn_row = tk.Frame(file_frame)
btn_row.pack(fill="x")

tk.Button(btn_row, text="반품 자동화 엑셀 선택", command=select_file,
          bg="#6c757d", fg="white", padx=10, pady=4).pack(side="left", padx=(0, 6))

tk.Button(btn_row, text="자동업로드 CSV 선택", command=select_auto_upload_file,
          bg="#6f42c1", fg="white", padx=10, pady=4).pack(side="left", padx=(0, 6))

tk.Button(btn_row, text="교환송장등록 엑셀선택", command=select_exchange_invoice_file,
          bg="#0d6efd", fg="white", padx=10, pady=4).pack(side="left", padx=(0, 6))

tk.Button(btn_row, text="3번째 엑셀 선택", command=select_excel3_file,
          bg="#198754", fg="white", padx=10, pady=4).pack(side="left", padx=(0, 6))
btn_row.winfo_children()[-1].config(text="교환회수송장등록선택")

file_label = tk.Label(file_frame, text="선택된 파일 없음", anchor="w", fg="#666666")
file_label.pack(anchor="w", pady=(6, 0))

# ---- 필터 설정 ----
filter_row = tk.Frame(file_frame)
filter_row.pack(fill="x", pady=(8, 0))

filter_enabled_var = tk.BooleanVar(value=False)
tk.Checkbutton(filter_row, text="행 필터 사용", variable=filter_enabled_var,
               font=("Malgun Gothic", 9, "bold")).pack(side="left")

tk.Label(filter_row, text="열:").pack(side="left", padx=(12, 2))
filter_col_var = tk.StringVar(value="")
filter_col_entry = tk.Entry(filter_row, textvariable=filter_col_var, width=5,
                             font=("Malgun Gothic", 9))
filter_col_entry.pack(side="left")

tk.Label(filter_row, text="포함 텍스트:").pack(side="left", padx=(10, 2))
filter_text_var = tk.StringVar(value="")
filter_text_entry = tk.Entry(filter_row, textvariable=filter_text_var, width=14,
                              font=("Malgun Gothic", 9))
filter_text_entry.pack(side="left", padx=(0, 6))

tk.Label(filter_row, text="시작 텍스트:").pack(side="left", padx=(4, 2))
filter_startswith_var = tk.StringVar(value="")
filter_startswith_entry = tk.Entry(filter_row, textvariable=filter_startswith_var, width=10,
                                    font=("Malgun Gothic", 9))
filter_startswith_entry.pack(side="left", padx=(0, 10))

tk.Label(filter_row,
         text="예) 열: B  시작 텍스트: 2  →  B열이 '2'로 시작하는 행만 반복",
         fg="#888888", font=("Malgun Gothic", 8)).pack(side="left")

# ---- 액션 버튼 영역 ----
action_button_frame = tk.LabelFrame(main, text="액션 추가", padx=8, pady=8)
action_button_frame.pack(fill="x", pady=(0, 8))

def _btn(parent, text, cmd, col, row=0):
    tk.Button(parent, text=text, command=cmd, width=14, pady=3).grid(
        row=row, column=col, padx=3, pady=2, sticky="w"
    )

# 0행: 마우스 클릭류
_btn(action_button_frame, "클릭 (2초)",     add_click,        0, 0)
_btn(action_button_frame, "더블클릭 (2초)", add_double_click,  1, 0)
_btn(action_button_frame, "3번클릭 (2초)",  add_triple_click,  2, 0)
_btn(action_button_frame, "우클릭 (2초)",   add_right_click,   3, 0)
_btn(action_button_frame, "키 입력",        add_key,           4, 0)
# 1행: 클립보드 / 엑셀 열
_btn(action_button_frame, "붙여넣기",       add_paste,                    0, 1)
_btn(action_button_frame, "복사(ctrl+c)",   add_copy,                     1, 1)
_btn(action_button_frame, "열 복사",        add_auto_copy_col,            2, 1)
_btn(action_button_frame, "열 붙여넣기",    add_auto_paste_col,           3, 1)
_btn(action_button_frame, "카테고리 매핑",  add_auto_copy_category_map,   4, 1)
_btn(action_button_frame, "복사값 열비교",   add_skip_if_clipboard_not_equal_col, 5, 1)
# 2행: 텍스트·URL·대기·스크롤
_btn(action_button_frame, "텍스트 복사",    add_copy_text,                0, 2)
_btn(action_button_frame, "URL 기억",       add_remember_url,             1, 2)
_btn(action_button_frame, "URL 변화 확인",  add_check_url_no_change_skip, 2, 2)
_btn(action_button_frame, "URL 이동",       add_open_url,                 3, 2)
_btn(action_button_frame, "대기",           add_wait,                     4, 2)
_btn(action_button_frame, "스크롤",         add_scroll,                   5, 2)

# ---- 액션 목록 ----
list_frame = tk.LabelFrame(main, text="액션 목록", padx=8, pady=8)
list_frame.pack(fill="x", pady=(0, 8))

list_box_frame = tk.Frame(list_frame)
list_box_frame.pack(fill="x")

scrollbar = ttk.Scrollbar(list_box_frame, orient="vertical")
action_listbox = tk.Listbox(list_box_frame, height=10, yscrollcommand=scrollbar.set,
                             selectmode=tk.EXTENDED, font=("Malgun Gothic", 9))
scrollbar.config(command=action_listbox.yview)
action_listbox.pack(side="left", fill="x", expand=True)
scrollbar.pack(side="right", fill="y")
bind_mousewheel(action_listbox)

list_controls = tk.Frame(list_frame)
list_controls.pack(fill="x", pady=(6, 0))

tk.Button(list_controls, text="삭제", command=delete_selected_action, width=8).pack(side="left", padx=2)
tk.Button(list_controls, text="↑ 위로", command=lambda: move_selected_action(-1), width=8).pack(side="left", padx=2)
tk.Button(list_controls, text="↓ 아래", command=lambda: move_selected_action(1), width=8).pack(side="left", padx=2)
tk.Button(list_controls, text="전체 삭제", command=clear_actions, width=8).pack(side="left", padx=2)

flag_row = tk.Frame(list_frame)
flag_row.pack(fill="x", pady=(4, 0))
tk.Label(flag_row, text="선택 액션 플래그:").pack(side="left")
tk.Button(flag_row, text="[최초만]", command=toggle_first_only_action, width=9).pack(side="left", padx=2)
tk.Button(flag_row, text="[두번째부터]", command=toggle_after_first_action, width=10).pack(side="left", padx=2)
tk.Button(flag_row, text="[옵션3개만]", command=toggle_option3_only_action, width=10).pack(side="left", padx=2)
tk.Button(flag_row, text="[옵션3개아님]", command=toggle_option3_except_action, width=11).pack(side="left", padx=2)
tk.Button(flag_row, text="[4부터시작함]", command=toggle_clipboard_starts4_action, width=12).pack(side="left", padx=2)
tk.Button(flag_row, text="메모 편집", command=edit_action_note, width=9).pack(side="left", padx=2)

action_count_var = tk.StringVar(value="액션 0개")
tk.Label(list_frame, textvariable=action_count_var, anchor="w", fg="#0b5c8c").pack(anchor="w", pady=(4, 0))

# ---- 템플릿 영역 ----
template_frame = tk.LabelFrame(main, text="템플릿 관리", padx=8, pady=8)
template_frame.pack(fill="x", pady=(0, 8))

t_row1 = tk.Frame(template_frame)
t_row1.pack(fill="x", pady=(0, 4))

tk.Label(t_row1, text="메인 템플릿:").pack(side="left")
template_var = tk.StringVar()
template_combo = ttk.Combobox(t_row1, textvariable=template_var, width=22, state="readonly")
template_combo.pack(side="left", padx=4)
tk.Button(t_row1, text="불러오기", command=load_template, width=8).pack(side="left", padx=2)
tk.Button(t_row1, text="저장", command=save_template, width=6).pack(side="left", padx=2)
tk.Button(t_row1, text="선택 저장", command=save_selected_template, width=9).pack(side="left", padx=2)
tk.Button(t_row1, text="삭제", command=delete_template, width=6).pack(side="left", padx=2)

t_row2 = tk.Frame(template_frame)
t_row2.pack(fill="x", pady=(0, 4))
tk.Label(t_row2, text="행 완료 후 템플릿:").pack(side="left")
after_template_var = tk.StringVar(value="(없음)")
after_template_combo = ttk.Combobox(t_row2, textvariable=after_template_var, width=22, state="readonly")
after_template_combo.pack(side="left", padx=4)

t_row3 = tk.Frame(template_frame)
t_row3.pack(fill="x")
tk.Label(t_row3, text="마무리 템플릿:").pack(side="left")
final_template_var = tk.StringVar(value="(없음)")
final_template_combo = ttk.Combobox(t_row3, textvariable=final_template_var, width=22, state="readonly")
final_template_combo.pack(side="left", padx=4)

# ---- 설정 영역 ----
settings_frame = tk.LabelFrame(main, text="설정", padx=8, pady=8)
settings_frame.pack(fill="x", pady=(0, 8))

s_row = tk.Frame(settings_frame)
s_row.pack(fill="x")

tk.Label(s_row, text="액션 간 딜레이(초):").pack(side="left")
delay_entry = tk.Entry(s_row, width=8)
delay_entry.insert(0, "0.1")
delay_entry.pack(side="left", padx=(4, 20))

tk.Label(s_row, text="반복 행 수 (엑셀 미선택 시):").pack(side="left")
selected_count_entry = tk.Entry(s_row, width=8)
selected_count_entry.insert(0, "1")
selected_count_entry.pack(side="left", padx=4)

tk.Label(s_row, text="시작 행 (엑셀):").pack(side="left", padx=(20, 2))
start_row_entry = tk.Entry(s_row, width=6)
start_row_entry.insert(0, "1")
start_row_entry.pack(side="left", padx=4)

# ---- 실행 버튼 영역 ----
run_button_frame = tk.Frame(main)
run_button_frame.pack(fill="x", pady=(0, 8))

start_button = tk.Button(run_button_frame, text="▶ 자동화 시작",
                          command=lambda: start_macro(False, False),
                          bg="#0d6efd", fg="white", padx=16, pady=6, font=("Malgun Gothic", 10, "bold"))
start_button.pack(side="left", padx=(0, 6))

start_selected_button = tk.Button(run_button_frame, text="선택 행부터 시작",
                                   command=lambda: start_macro(True, False),
                                   bg="#0d6efd", fg="white", padx=10, pady=6)
start_selected_button.pack(side="left", padx=(0, 6))

start_one_button = tk.Button(run_button_frame, text="선택 액션만 실행",
                              command=lambda: start_macro(False, True),
                              bg="#fd7e14", fg="white", padx=10, pady=6)
start_one_button.pack(side="left", padx=(0, 6))

stop_button = tk.Button(run_button_frame, text="■ 중지 (F4)",
                         command=stop_macro,
                         bg="#dc3545", fg="white", padx=10, pady=6,
                         state=tk.DISABLED)
stop_button.pack(side="left")

# ---- 상태바 ----
status_var = tk.StringVar(value="준비")
status_label = tk.Label(root, textvariable=status_var, anchor="w",
                         relief=tk.SUNKEN, padx=8, fg="#333333")
status_label.pack(fill="x", side="bottom")

# ---- 초기화 ----
refresh_template_options()

root.mainloop()
