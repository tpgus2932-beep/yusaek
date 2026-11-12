"""이지오토 패킷 캡처 도구 (윈도우 기본 pktmon 사용, 관리자 권한 필요).

ezauto_capture.py(hosts 우회 중계)로 잡히지 않는 통신을 찾기 위한 도구다.
이지오토가 접속하는 80포트(일반 HTTP)와 3030포트(이지어드민 쪽으로 추정)의 TCP 패킷을 통째로 캡처한 뒤,
패킷을 다시 조립해서 HTTP 요청/응답(또는 HTTP가 아닌 통신)을 "값이 가려진 구조"로 요약한다.
443(HTTPS)은 암호화되어 있어 내용을 볼 수 없으므로 캡처하지 않는다.

사용법 (관리자 권한 PowerShell):
    python backend\\tools\\ezauto_pktcapture.py              # 캡처 시작 -> 이지오토에서 '자동발주' 실행 -> Ctrl+C
    python backend\\tools\\ezauto_pktcapture.py --analyze 파일.pcapng   # 이미 만든 pcapng 다시 분석 (관리자 불필요)

결과 (%USERPROFILE%\\ezauto_capture\\):
    pkt_summary.txt   구조 요약 (값은 가려짐) -> 이 파일만 공유
    pkt_*.pcapng/.etl 원본 패킷. 고객 개인정보가 들어 있으니 공유 금지, 작업 후 삭제
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ezauto_capture as base  # noqa: E402  (마스킹 함수 재사용)

OUT_DIR = base.OUT_DIR
PORTS = (80, 3030)
_FILTERS = [("ezauto80", 80), ("ezauto3030", 3030)]


# ---------------------------------------------------------------- pcapng 읽기
def read_pcapng(path: Path):
    """pcapng에서 (인터페이스 링크타입, 시각, 프레임 바이트)를 차례로 돌려준다."""
    data = path.read_bytes()
    pos, endian, links = 0, "<", []
    while pos + 12 <= len(data):
        btype = struct.unpack_from("<I", data, pos)[0]
        if btype == 0x0A0D0D0A:  # Section Header: 바이트 순서 확인
            magic = struct.unpack_from("<I", data, pos + 8)[0]
            endian = "<" if magic == 0x1A2B3C4D else ">"
            links = []
        btype, blen = struct.unpack_from(endian + "II", data, pos)
        if blen < 12 or pos + blen > len(data):
            break
        body = data[pos + 8:pos + blen - 4]
        if btype == 1:  # Interface Description
            links.append(struct.unpack_from(endian + "H", body, 0)[0])
        elif btype == 6:  # Enhanced Packet
            iface, th, tl, caplen, _orig = struct.unpack_from(endian + "IIIII", body, 0)
            ts = ((th << 32) | tl) / 1_000_000
            yield (links[iface] if iface < len(links) else 1), ts, body[20:20 + caplen]
        pos += blen


def parse_tcp(linktype: int, frame: bytes):
    """이더넷/IP/TCP 프레임 -> (src, sport, dst, dport, seq, flags, payload). TCP가 아니면 None."""
    if linktype != 1 or len(frame) < 14:
        return None
    off, etype = 12, struct.unpack_from(">H", frame, 12)[0]
    while etype in (0x8100, 0x88A8) and len(frame) >= off + 6:  # VLAN 태그
        off += 4
        etype = struct.unpack_from(">H", frame, off)[0]
    off += 2
    if etype == 0x0800 and len(frame) >= off + 20:
        ihl = (frame[off] & 0x0F) * 4
        total = struct.unpack_from(">H", frame, off + 2)[0]
        if frame[off + 9] != 6:
            return None
        src = ".".join(map(str, frame[off + 12:off + 16]))
        dst = ".".join(map(str, frame[off + 16:off + 20]))
        tcp = off + ihl
        ip_end = min(off + total, len(frame))
    elif etype == 0x86DD and len(frame) >= off + 40:
        if frame[off + 6] != 6:
            return None
        src, dst = frame[off + 8:off + 24].hex(), frame[off + 24:off + 40].hex()
        tcp = off + 40
        ip_end = min(off + 40 + struct.unpack_from(">H", frame, off + 4)[0], len(frame))
    else:
        return None
    if len(frame) < tcp + 20:
        return None
    sport, dport, seq = struct.unpack_from(">HHI", frame, tcp)
    hdr = (frame[tcp + 12] >> 4) * 4
    flags = frame[tcp + 13]
    return src, sport, dst, dport, seq, flags, frame[tcp + hdr:ip_end]


class Flow:
    """한 방향의 TCP 바이트 흐름."""

    def __init__(self):
        self.segs: dict[int, bytes] = {}
        self.isn: int | None = None
        self.first_ts = 0.0

    def add(self, seq: int, flags: int, payload: bytes, ts: float):
        if flags & 0x02:  # SYN
            self.isn = (seq + 1) & 0xFFFFFFFF
        if payload:
            if len(payload) > len(self.segs.get(seq, b"")):
                self.segs[seq] = payload
            self.first_ts = self.first_ts or ts

    def stream(self) -> tuple[bytes, bool]:
        """이어진 바이트열과 중간에 빠진 구간이 있었는지."""
        if not self.segs:
            return b"", False
        start = self.isn if self.isn is not None else min(self.segs, key=lambda s: s)
        out, nxt, gap = bytearray(), start, False
        for seq in sorted(self.segs, key=lambda s: (s - start) & 0xFFFFFFFF):
            rel = (seq - nxt) & 0xFFFFFFFF
            data = self.segs[seq]
            if rel >= 0x80000000:  # 이미 지난 구간과 겹침
                skip = (nxt - seq) & 0xFFFFFFFF
                if skip < len(data):
                    out += data[skip:]
                    nxt = (nxt + len(data) - skip) & 0xFFFFFFFF
            elif rel == 0:
                out += data
                nxt = (nxt + len(data)) & 0xFFFFFFFF
            else:  # 빠진 구간
                gap = True
                out += data
                nxt = (seq + len(data)) & 0xFFFFFFFF
        return bytes(out), gap


# ---------------------------------------------------------------- HTTP 해석
_METHODS = (b"GET ", b"POST ", b"PUT ", b"DELETE ", b"HEAD ", b"OPTIONS ", b"PATCH ")


def _read_body(buf: bytes, pos: int, headers: dict, is_response: bool) -> tuple[bytes, int]:
    if "chunked" in headers.get("transfer-encoding", "").lower():
        out = bytearray()
        while True:
            eol = buf.find(b"\r\n", pos)
            if eol < 0:
                return bytes(out), len(buf)
            size = int(buf[pos:eol].split(b";")[0] or b"0", 16)
            pos = eol + 2
            if size == 0:
                end = buf.find(b"\r\n\r\n", eol)
                return bytes(out), (end + 4 if end >= 0 else len(buf))
            out += buf[pos:pos + size]
            pos += size + 2
    if "content-length" in headers:
        n = int(headers["content-length"])
        return buf[pos:pos + n], pos + n
    return (buf[pos:], len(buf)) if is_response else (b"", pos)


def parse_http(buf: bytes, is_response: bool):
    """바이트열에서 HTTP 메시지들을 꺼낸다. HTTP가 아니면 None."""
    if not buf:
        return []
    if is_response and not buf.startswith(b"HTTP/"):
        return None
    if not is_response and not buf.startswith(_METHODS):
        return None
    msgs, pos = [], 0
    while pos < len(buf):
        end = buf.find(b"\r\n\r\n", pos)
        if end < 0:
            break
        lines = buf[pos:end].decode("latin-1").split("\r\n")
        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        try:
            body, pos = _read_body(buf, end + 4, headers, is_response)
        except (ValueError, IndexError):
            break
        msgs.append({"start": lines[0], "headers": headers, "body": body})
    return msgs


# ---------------------------------------------------------------- 가려서 보여주기
def describe_xml(text: str):
    try:
        root = ET.fromstring(re.sub(r"^\s*<\?xml[^>]*\?>", "", text).strip().encode("utf-8"))
    except ET.ParseError:
        return None
    seen: Counter = Counter()
    shown: dict[str, list] = defaultdict(list)
    for el in root.iter():
        seen[el.tag] += 1
        if len(shown[el.tag]) < 2:
            attrs = {k: (v[:40] if k in base.SAFE_KEYS else f"<{len(v)}>") for k, v in el.attrib.items()}
            txt = (el.text or "").strip()
            shown[el.tag].append({**attrs, **({"__text__": f"<{len(txt)}>"} if txt else {})})
    return {"__xml__": {tag: {"개수": seen[tag], "예시": shown[tag]} for tag in seen}}


def describe_any(raw: bytes, headers: dict | None = None):
    headers = headers or {}
    if not raw:
        return "<empty>"
    text = raw.decode("utf-8", errors="replace")
    if text.lstrip()[:1] == "<":
        x = describe_xml(text)
        if x:
            return x
    return base.describe_body(raw, headers.get("content-type", ""), headers.get("content-encoding", ""))


def _kind_of(raw: bytes) -> str:
    """'tls' | 'text' | 'binary' | 'empty' (한글이 섞인 UTF-8 텍스트도 text로 본다)."""
    if not raw:
        return "empty"
    if raw[:2] == b"\x16\x03":
        return "tls"
    chars = raw[:200].decode("utf-8", errors="ignore")
    if chars and b"\x00" not in raw[:200] and sum(c.isprintable() or c in "\t\r\n" for c in chars) / len(chars) > 0.85:
        return "text"
    return "binary"


def shape_bytes(raw: bytes, limit: int = 120) -> str:
    """HTTP가 아닌 통신: 텍스트는 앞부분을 가려서(숫자->9, 한글->가) 보여준다.
    이진 데이터는 값이 새지 않도록 맨 앞 8바이트(프로토콜 머리 확인용)만 16진수로 보여준다."""
    kind = _kind_of(raw)
    if kind == "empty":
        return "<empty>"
    if kind == "tls":
        return "<TLS 암호화 통신>"
    if kind == "text":
        text = re.sub(r"[가-힣]", "가", re.sub(r"\d", "9", raw[:limit].decode("utf-8", errors="ignore")))
        return f"<text {len(raw)}바이트> {text!r}"
    return f"<binary {len(raw)}바이트> 앞8바이트hex={raw[:8].hex()}"


# ---------------------------------------------------------------- 분석
def analyze(pcap: Path) -> str:
    flows: dict[tuple, Flow] = {}
    syn_from: dict[frozenset, tuple] = {}
    pkts = 0
    for link, ts, frame in read_pcapng(pcap):
        t = parse_tcp(link, frame)
        if not t:
            continue
        src, sport, dst, dport, seq, flags, payload = t
        if sport not in PORTS and dport not in PORTS:
            continue
        pkts += 1
        key = (src, sport, dst, dport)
        flows.setdefault(key, Flow()).add(seq, flags, payload, ts)
        if flags & 0x02 and not flags & 0x10:  # 연결을 시작한 쪽 = 클라이언트
            syn_from[frozenset(((src, sport), (dst, dport)))] = (src, sport)

    conns: dict[frozenset, dict] = {}
    for (src, sport, dst, dport), fl in flows.items():
        pair = frozenset(((src, sport), (dst, dport)))
        client = syn_from.get(pair) or ((src, sport) if dport in PORTS else (dst, dport))
        role = "up" if (src, sport) == client else "down"
        conns.setdefault(pair, {"client": client})[role] = fl
    lines = [f"# 이지오토 패킷 캡처 요약 ({datetime.now():%Y-%m-%d %H:%M:%S})  패킷 {pkts}개, 연결 {len(conns)}개",
             "# 값은 가려져 있음: <str:길이>, 숫자->9, 한글->가 / 안전한 키만 원문 표시", ""]

    dest_stats: dict[str, dict] = defaultdict(lambda: {"연결": 0, "올림": 0, "받음": 0, "종류": set()})
    groups: dict[str, dict] = {}
    for pair, c in sorted(conns.items(), key=lambda kv: min((f.first_ts for f in (kv[1].get("up"), kv[1].get("down")) if f), default=0)):
        up, down = c.get("up"), c.get("down")
        (cip, cport) = c["client"]
        server = next(e for e in pair if e != c["client"])
        dest = f"{server[0]}:{server[1]}"
        up_bytes, up_gap = (up.stream() if up else (b"", False))
        down_bytes, down_gap = (down.stream() if down else (b"", False))
        st = dest_stats[dest]
        st["연결"] += 1
        st["올림"] += len(up_bytes)
        st["받음"] += len(down_bytes)
        reqs, resps = parse_http(up_bytes, False), parse_http(down_bytes, True)
        if reqs is not None and resps is not None:
            st["종류"].add("HTTP")
            for i, rq in enumerate(reqs):
                rs = resps[i] if i < len(resps) else {"start": "(응답 없음)", "headers": {}, "body": b""}
                req_desc, resp_desc = describe_any(rq["body"], rq["headers"]), describe_any(rs["body"], rs["headers"])
                path = rq["start"].split(" ")[1] if " " in rq["start"] else rq["start"]
                sig = f"{dest} {rq['start'].split(' ')[0]} {base.signature(path, req_desc)}"
                g = groups.setdefault(sig, {"n": 0, "query": base.mask_query(path.partition('?')[2]), "status": rs["start"],
                                            "req": req_desc, "resp": resp_desc, "mx_req": 0, "mx_resp": 0,
                                            "host": rq["headers"].get("host", "")})
                g["n"] += 1
                g["mx_req"], g["mx_resp"] = max(g["mx_req"], len(rq["body"])), max(g["mx_resp"], len(rs["body"]))
                size = lambda d: len(json.dumps(d, ensure_ascii=False, default=str))  # noqa: E731
                if size(req_desc) > size(g["req"]):
                    g["req"] = req_desc
                if size(resp_desc) > size(g["resp"]):
                    g["resp"] = resp_desc
        else:
            st["종류"].add("HTTP 아님")
            sig = f"{dest} (HTTP 아님: {_kind_of(up_bytes)})"
            g = groups.setdefault(sig, {"n": 0, "raw": True, "up": shape_bytes(up_bytes), "down": shape_bytes(down_bytes),
                                        "mx_req": 0, "mx_resp": 0, "gap": False})
            g["n"] += 1
            g["mx_req"], g["mx_resp"] = max(g["mx_req"], len(up_bytes)), max(g["mx_resp"], len(down_bytes))
            g["gap"] = g["gap"] or up_gap or down_gap

    lines.append("## 접속 대상별 통신량")
    for dest, st in sorted(dest_stats.items()):
        lines.append(f"- {dest}: 연결 {st['연결']}개, 올린 {st['올림']}바이트 / 받은 {st['받음']}바이트, 종류 {','.join(sorted(st['종류']))}")
    lines.append("\n## 요청 종류별 요약")
    for sig, g in groups.items():
        lines.append(f"\n### {sig}   x{g['n']}")
        if g.get("raw"):
            lines.append(f"- 올린 데이터 최대 {g['mx_req']}바이트 / 받은 데이터 최대 {g['mx_resp']}바이트" + ("  (일부 패킷 누락)" if g["gap"] else ""))
            lines.append(f"- 올린 데이터 모양: {g['up']}")
            lines.append(f"- 받은 데이터 모양: {g['down']}")
            continue
        lines.append(f"- Host: {g['host']} / query: {g['query'] or '-'} / 응답: {g['status']}")
        lines.append(f"- 요청 본문 최대 {g['mx_req']}바이트 / 응답 본문 최대 {g['mx_resp']}바이트")
        lines.append("- 요청 구조: " + json.dumps(g["req"], ensure_ascii=False, default=str, indent=1))
        lines.append("- 응답 구조: " + json.dumps(g["resp"], ensure_ascii=False, default=str, indent=1))
    return "\n".join(lines)


# ---------------------------------------------------------------- 캡처 실행
def _pktmon(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    res = subprocess.run(["pktmon", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and res.returncode != 0:
        raise RuntimeError(f"pktmon {' '.join(args)} 실패: {(res.stdout + res.stderr).strip()[:300]}")
    return res


def main() -> int:
    parser = argparse.ArgumentParser(description="이지오토 패킷 캡처 (pktmon)")
    parser.add_argument("--analyze", help="이미 만든 pcapng 파일을 분석만 한다")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.analyze:
        text = analyze(Path(args.analyze))
        (OUT_DIR / "pkt_summary.txt").write_text(text, encoding="utf-8")
        print(f"요약 저장: {OUT_DIR / 'pkt_summary.txt'}")
        return 0

    if not ctypes.windll.shell32.IsUserAnAdmin():
        print("패킷 캡처는 '관리자 권한' PowerShell에서 실행해야 합니다.")
        return 1
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    etl, pcap = OUT_DIR / f"pkt_{stamp}.etl", OUT_DIR / f"pkt_{stamp}.pcapng"
    _pktmon("filter", "remove", check=False)
    for name, port in _FILTERS:
        _pktmon("filter", "add", name, "-t", "TCP", "-p", str(port))
    _pktmon("start", "--capture", "--comp", "nics", "--pkt-size", "0", "--file-name", str(etl))
    print(f"[캡처 중] 80/3030 포트 TCP -> {etl}")
    print("이지오토에서 '자동발주'를 1회 실행하세요. 완료 메시지가 뜨면 이 창에서 Ctrl+C.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        _pktmon("stop", check=False)
        _pktmon("filter", "remove", check=False)
    print("패킷 변환/분석 중...")
    _pktmon("etl2pcap", str(etl), "--out", str(pcap))
    text = analyze(pcap)
    (OUT_DIR / "pkt_summary.txt").write_text(text, encoding="utf-8")
    print(f"\n완료. 요약: {OUT_DIR / 'pkt_summary.txt'}")
    print("원본(.etl/.pcapng)에는 개인정보가 있으니 공유하지 말고 작업 후 삭제하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
