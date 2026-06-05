from __future__ import annotations

from pathlib import Path
from typing import Callable

import pandas as pd


DataFrameReader = Callable[[Path], pd.DataFrame]
DataFrameWriter = Callable[[pd.DataFrame], None]


def parse_tsv_rows(
    raw_text: str,
    *,
    min_columns: int = 2,
    max_columns: int | None = None,
    skip_header: bool = False,
) -> list[list[str]]:
    text = str(raw_text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    rows: list[list[str]] = []

    for line_number, line in enumerate(text.split("\n"), start=1):
        if not line.strip():
            continue

        values = [part.strip() for part in line.split("\t")]
        if len(values) < min_columns:
            raise ValueError(f"TSV {line_number}행은 최소 {min_columns}열이 필요합니다.")

        rows.append(values[:max_columns] if max_columns is not None else values)

    if skip_header and rows:
        rows = rows[1:]

    if not rows:
        raise ValueError("추가할 TSV 데이터가 없습니다.")

    return rows


def append_tsv_rows_to_excel(
    path: Path,
    raw_text: str,
    *,
    read_df: DataFrameReader,
    save_df: DataFrameWriter,
    required_columns: int = 2,
    append_columns: int = 2,
    target_column_indices: list[int] | None = None,
    skip_header: bool = False,
) -> dict[str, int]:
    if not path.exists():
        raise FileNotFoundError(f"원가베이스 파일이 없습니다: {path}")

    df = read_df(path)
    if df.shape[1] < required_columns:
        raise ValueError(f"원가베이스는 최소 {required_columns}열이 필요합니다.")

    rows = parse_tsv_rows(
        raw_text,
        min_columns=append_columns,
        max_columns=append_columns,
        skip_header=skip_header,
    )

    columns = list(df.columns)
    target_indices = target_column_indices or list(range(append_columns))
    if len(target_indices) != append_columns:
        raise ValueError("TSV column count and target column count do not match.")
    if any(index < 0 or index >= len(columns) for index in target_indices):
        raise ValueError("Target column index is outside the cost base columns.")

    append_payload = []
    for values in rows:
        row_data = {column: "" for column in columns}
        for source_index, target_index in enumerate(target_indices):
            row_data[columns[target_index]] = values[source_index]
        append_payload.append(row_data)

    appended_df = pd.DataFrame(append_payload, columns=columns)
    combined_df = pd.concat([df, appended_df], ignore_index=True)
    save_df(combined_df)
    return {"appended": len(append_payload), "total": len(combined_df)}
