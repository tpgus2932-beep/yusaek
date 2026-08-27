from __future__ import annotations
import struct


def get_image_dimensions(data: bytes) -> tuple[int, int]:
    """이미지 바이트에서 (width, height)를 읽는다. JPEG/PNG/WEBP만 지원, 실패 시 (0, 0).

    Pillow 등 외부 이미지 라이브러리 의존성 없이 지그재그 CreateCatalogProduct가
    요구하는 이미지 width/height를 채우기 위한 최소 구현.
    """
    if len(data) < 24:
        return (0, 0)

    if data[:8] == b"\x89PNG\r\n\x1a\n":
        width, height = struct.unpack(">II", data[16:24])
        return (width, height)

    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while i < n - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in sof_markers:
                height, width = struct.unpack(">HH", data[i + 5:i + 9])
                return (width, height)
            if marker == 0xD8 or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            if i + 4 > n:
                break
            seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
            i += 2 + seg_len
        return (0, 0)

    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8 " and len(data) >= 30:
            width, height = struct.unpack("<HH", data[26:30])
            return (width & 0x3FFF, height & 0x3FFF)
        if chunk == b"VP8L" and len(data) >= 25:
            b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
            width = 1 + (((b1 & 0x3F) << 8) | b0)
            height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | (b1 >> 6))
            return (width, height)
        if chunk == b"VP8X" and len(data) >= 30:
            width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
            height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
            return (width, height)

    return (0, 0)
