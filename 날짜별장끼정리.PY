import os
import re
import tkinter as tk
from tkinter import filedialog, messagebox
from datetime import date

import pandas as pd


def left_first_word(text: str) -> str:
    if not isinstance(text, str):
        return ""
    s = text.strip()
    if not s:
        return ""
    return s.split(" ", 1)[0].strip()


def mid_after_first_space(text: str) -> str:
    if not isinstance(text, str):
        return ""
    s = text.strip()
    if not s:
        return ""
    parts = s.split(" ", 1)
    return parts[1].strip() if len(parts) == 2 else ""


def extract_bracket_inside(text):
    if not isinstance(text, str):
        return None
    m = re.search(r"\[([^\]]+)\]", text)
    return m.group(1).strip() if m else None


def d_from_f(f_text: str) -> str:
    inside = extract_bracket_inside(f_text)
    if not inside:
        return ""
    return inside.split("-", 1)[0].strip() if "-" in inside else inside.strip()


def e_from_e(e_text: str) -> str:
    inside = extract_bracket_inside(e_text)
    if not inside:
        return "free"
    parts = [p.strip() for p in inside.split("-")]
    if len(parts) <= 1:
        return "free"
    merged = " ".join([p for p in parts[1:] if p]).strip()
    return merged if merged else "free"


def ensure_min_columns(df: pd.DataFrame, min_cols: int) -> pd.DataFrame:
    if df.shape[1] >= min_cols:
        return df
    for _ in range(min_cols - df.shape[1]):
        df[f"__EMPTY_{df.shape[1] + 1}__"] = ""
    return df


class ExcelFillGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("엑셀 가공 프로그램 (A~G 저장 + 마지막 행 삭제)")
        self.root.geometry("820x300")

        self.file_path = ""

        tk.Label(
            root,
            text="A~G만 저장하고, 마지막 행은 자동 삭제합니다.",
            justify="left"
        ).pack(pady=10, anchor="w", padx=10)

        frame_file = tk.Frame(root)
        frame_file.pack(fill="x", padx=10, pady=5)

        tk.Label(frame_file, text="선택한 파일: ").pack(side="left")
        self.path_entry = tk.Entry(frame_file, width=85)
        self.path_entry.pack(side="left", padx=5)

        tk.Button(frame_file, text="파일 선택", command=self.select_file).pack(side="left", padx=5)

        frame_btn = tk.Frame(root)
        frame_btn.pack(pady=12)

        tk.Button(frame_btn, text="가공 시작", width=20, height=2, command=self.process).pack(side="left", padx=10)
        tk.Button(frame_btn, text="닫기", width=12, height=2, command=root.quit).pack(side="left", padx=10)

        self.status = tk.Label(root, text="대기 중입니다.", fg="blue")
        self.status.pack(pady=10)

    def select_file(self):
        path = filedialog.askopenfilename(
            title="가공할 엑셀 파일 선택",
            filetypes=[("Excel files", "*.xlsx *.xls"), ("All files", "*.*")]
        )
        if not path:
            return
        self.file_path = path
        self.path_entry.delete(0, tk.END)
        self.path_entry.insert(0, self.file_path)
        self.status.config(text="파일 선택 완료", fg="green")

    def process(self):
        if not self.file_path:
            messagebox.showwarning("경고", "먼저 엑셀 파일을 선택해주세요.")
            return

        try:
            self.status.config(text="엑셀 불러오는 중...", fg="orange")
            self.root.update_idletasks()

            df = pd.read_excel(self.file_path, engine="openpyxl")
            df = ensure_min_columns(df, 7)

            colA = df.columns[0]
            colB = df.columns[1]
            colD = df.columns[3]
            colE = df.columns[4]
            colF = df.columns[5]
            colG = df.columns[6]

            b_src = df[colB]
            e_src = df[colE]
            f_src = df[colF]
            g_src = df[colG]

            today_str = date.today().strftime("%Y-%m-%d")

            df[colA] = b_src.apply(left_first_word)
            df[colB] = b_src.apply(mid_after_first_space)
            df[colD] = f_src.apply(d_from_f)
            df[colE] = e_src.apply(e_from_e)
            df[colF] = pd.to_numeric(g_src, errors="coerce")
            df[colG] = today_str

            # A~G까지만 남김
            df_out = df.iloc[:, :7].copy()

            # ✅ 마지막 행 삭제
            if len(df_out) > 0:
                df_out = df_out.iloc[:-1]

            base, _ = os.path.splitext(self.file_path)
            out_path = base + "_가공.xlsx"

            self.status.config(text="저장 중...", fg="orange")
            self.root.update_idletasks()

            with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
                df_out.to_excel(writer, sheet_name="Sheet1", index=False)

            self.status.config(text="완료!", fg="blue")
            messagebox.showinfo("완료", f"가공 완료!\n\n저장 위치:\n{out_path}")

        except Exception as e:
            self.status.config(text="에러 발생", fg="red")
            messagebox.showerror("에러", f"가공 중 오류가 발생했습니다.\n\n{e}")


def main():
    root = tk.Tk()
    ExcelFillGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
