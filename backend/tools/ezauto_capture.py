"""이지오토(ezauto) <-> ezauto.ezadmin.co.kr 통신 캡처 도구.

이지오토가 이지어드민에 발주를 입력할 때(reg_orders_manual 등) 실제로 보내는 요청 형식을 알아내기 위한 도구다.
이지오토는 http://ezauto.ezadmin.co.kr (일반 HTTP)로 통신하므로, 그 주소를 잠시 이 PC(127.0.0.1)로 돌려
로컬 중계기가 요청을 기록하고 원래 서버로 그대로 전달한다. 이지오토 입장에서는 아무것도 달라지지 않는다.

사용법 (관리자 권한 PowerShell):
    python backend\\tools\\ezauto_capture.py            # 시작. 켜 둔 채로 이지오토를 (재)시작하고 자동발주 1회 실행
    (끝나면 Ctrl+C)                                      # hosts 파일은 자동으로 원상복구된다
    python backend\\tools\\ezauto_capture.py --restore   # 비정상 종료로 hosts가 남았을 때 복구

결과 (%USERPROFILE%\\ezauto_capture\\):
    summary.txt  요청/응답의 "구조"만 정리한 파일. 값은 가려져 있다(고객 정보 없음) -> 이 파일만 공유하면 된다.
    raw.log      원문 전체. 고객 개인정보·인증값이 들어 있으니 공유하지 말고 작업 후 삭제한다.
"""
from __future__ import annotations

import argparse
import atexit
import ctypes
import gzip
import http.client
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

TARGET_HOST = "ezauto.ezadmin.co.kr"
HOSTS_FILE = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "drivers" / "etc" / "hosts"
MARK = "# ezauto-capture"
OUT_DIR = Path(os.environ.get("USERPROFILE", ".")) / "ezauto_capture"

# 값을 그대로 보여줘도 되는(개인정보가 아닌) 키들. 나머지 값은 "<str:길이>"처럼 형태만 남긴다.
SAFE_KEYS = {
    "cAction", "work", "domain", "host", "shop_id", "RN", "action", "type", "mode", "status", "state",
    "success", "error", "cnt_total", "cnt_new", "cnt_balju", "delivery_sno", "m_strShopId", "version",
}
_HOP_HEADERS = {"connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailers"}

_lock = threading.Lock()
_groups: dict[str, dict] = {}
_remote_endpoints: set[str] = set()
_stop = threading.Event()


# ---------------------------------------------------------------- 가리기(마스킹)
def describe(value, key: str = ""):
    """값의 '구조'만 돌려준다. 안전한 키의 값만 원문을 보여준다."""
    if isinstance(value, dict):
        return {k: describe(v, k) for k, v in list(value.items())[:60]}
    if isinstance(value, list):
        return [f"list[{len(value)}]"] + ([describe(value[0], key)] if value else [])
    if isinstance(value, (bool, int, float)) or value is None:
        return value if key in SAFE_KEYS else f"<{type(value).__name__}>"
    text = str(value)
    if key in SAFE_KEYS:
        return text[:40]
    if len(text) > 1 and text[0] in "{[":
        try:
            return {"__json__": describe(json.loads(text), key)}
        except ValueError:
            pass
    return f"<str:{len(text)}>"


def _shape_text(text: str, limit: int = 80) -> str:
    """파싱이 안 되는 본문: 숫자·한글을 가린 앞부분만 보여준다(태그/필드 이름 파악용)."""
    head = re.sub(r"\d", "9", text[:limit])
    head = re.sub(r"[가-힣]", "가", head)
    return f"<raw:{len(text)}자> {head!r}"


def describe_body(raw: bytes, content_type: str = "", encoding: str = ""):
    if not raw:
        return "<empty>"
    if "gzip" in (encoding or "").lower():
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    text = raw.decode("utf-8", errors="replace")
    stripped = text.strip()
    if stripped[:1] in "{[":
        try:
            return {"__json__": describe(json.loads(stripped))}
        except ValueError:
            pass
    if "=" in stripped and "<" not in stripped[:5] and "\n" not in stripped[:200]:
        pairs = parse_qsl(stripped, keep_blank_values=True)
        if pairs:
            return {k: describe(v, k) for k, v in pairs[:80]}
    return _shape_text(text)


def mask_query(query: str) -> str:
    pairs = parse_qsl(query, keep_blank_values=True)
    return "&".join(f"{k}={v[:40] if k in SAFE_KEYS else '<' + str(len(v)) + '>'}" for k, v in pairs)


def signature(path: str, body_desc) -> str:
    qs = dict(parse_qsl(urlsplit(path).query, keep_blank_values=True))
    action = qs.get("cAction") or (body_desc.get("cAction") if isinstance(body_desc, dict) else "") or ""
    work = qs.get("work") or (body_desc.get("work") if isinstance(body_desc, dict) else "") or ""
    return f"{urlsplit(path).path} cAction={action} work={work}".strip()


# ---------------------------------------------------------------- 기록
def _write_raw(line: str) -> None:
    with open(OUT_DIR / "raw.log", "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def record(method: str, path: str, req_headers: dict, req_body: bytes, status: int, resp_headers: dict, resp_body: bytes) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    req_desc = describe_body(req_body, req_headers.get("Content-Type", ""), req_headers.get("Content-Encoding", ""))
    resp_desc = describe_body(resp_body, resp_headers.get("Content-Type", ""), resp_headers.get("Content-Encoding", ""))
    sig = signature(path, req_desc)
    with _lock:
        g = _groups.setdefault(sig, {"count": 0, "first": ts, "method": method, "req": req_desc, "resp": resp_desc,
                                     "query": mask_query(urlsplit(path).query), "status": status, "max_req": 0, "max_resp": 0})
        g["count"] += 1
        g["last"] = ts
        g["max_req"] = max(g["max_req"], len(req_body))
        g["max_resp"] = max(g["max_resp"], len(resp_body))
        # 구조가 더 큰(필드가 많은) 예시가 나오면 그걸로 교체
        if len(json.dumps(req_desc, ensure_ascii=False, default=str)) > len(json.dumps(g["req"], ensure_ascii=False, default=str)):
            g["req"] = req_desc
        if len(json.dumps(resp_desc, ensure_ascii=False, default=str)) > len(json.dumps(g["resp"], ensure_ascii=False, default=str)):
            g["resp"] = resp_desc
        _write_raw(f"[{ts}] {method} {path} -> {status}")
        _write_raw("  REQ-HEAD: " + json.dumps({k: ("***" if k.lower() in ("cookie", "authorization") else v) for k, v in req_headers.items()}, ensure_ascii=False))
        _write_raw("  REQ-BODY: " + req_body.decode("utf-8", errors="replace")[:200000])
        _write_raw("  RESP-BODY: " + resp_body.decode("utf-8", errors="replace")[:200000])


def write_summary() -> None:
    with _lock:
        lines = [f"# 이지오토 통신 캡처 요약 ({datetime.now():%Y-%m-%d %H:%M:%S})", "# 값은 가려져 있음: <str:길이> = 문자열, 안전한 키만 원문 표시", ""]
        lines.append("## 요청 종류별 요약")
        for sig, g in sorted(_groups.items(), key=lambda kv: kv[1]["first"]):
            lines.append(f"\n### {sig}   x{g['count']}  ({g['first']}~{g.get('last', g['first'])})  HTTP {g['status']}")
            lines.append(f"- {g['method']} query: {g['query'] or '-'}")
            lines.append(f"- 요청 본문 최대 {g['max_req']}바이트 / 응답 최대 {g['max_resp']}바이트")
            lines.append("- 요청 구조: " + json.dumps(g["req"], ensure_ascii=False, default=str, indent=1))
            lines.append("- 응답 구조: " + json.dumps(g["resp"], ensure_ascii=False, default=str, indent=1))
        lines.append("\n## 이지오토(openpos3.exe)의 접속 대상 (IP:포트) - 일반 HTTP(80) 외에 다른 대상이 있는지 확인용")
        lines.extend(sorted(_remote_endpoints) or ["(없음)"])
        (OUT_DIR / "summary.txt").write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------- 중계기
class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    upstream = ("", 80)

    def log_message(self, *args):  # 콘솔 소음 제거
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        headers = {k: v for k, v in self.headers.items() if k.lower() not in _HOP_HEADERS}
        try:
            conn = http.client.HTTPConnection(*self.upstream, timeout=120)
            conn.request(self.command, self.path, body=body or None, headers={**headers, "Connection": "close"})
            resp = conn.getresponse()
            data = resp.read()
            resp_headers = {k: v for k, v in resp.getheaders() if k.lower() not in _HOP_HEADERS and k.lower() != "content-length"}
            status = resp.status
            conn.close()
        except Exception as exc:  # 원 서버 연결 실패
            self.send_error(502, f"upstream error: {exc}")
            return
        self.send_response(status)
        for k, v in resp_headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        try:
            record(self.command, self.path, dict(self.headers.items()), body, status, resp_headers, data)
        except Exception as exc:  # 기록 실패가 중계를 막으면 안 된다
            print("기록 실패:", exc)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _handle


def _watch_connections() -> None:
    """이지오토(openpos3.exe)가 실제로 접속하는 원격 IP:포트를 기록한다 (netstat 기반)."""
    while not _stop.is_set():
        try:
            tasks = subprocess.run(["tasklist", "/FI", "IMAGENAME eq openpos3.exe", "/FO", "CSV", "/NH"],
                                   capture_output=True, text=True, timeout=10).stdout
            pids = set(re.findall(r'"openpos3\.exe","(\d+)"', tasks))
            if pids:
                net = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=10).stdout
                for line in net.splitlines():
                    parts = line.split()
                    if len(parts) >= 5 and parts[-1] in pids and parts[3] in ("ESTABLISHED", "SYN_SENT", "TIME_WAIT"):
                        remote = parts[2]
                        if not remote.startswith(("127.", "[::1]")):
                            _remote_endpoints.add(remote)
        except Exception:
            pass
        _stop.wait(2)


# ---------------------------------------------------------------- hosts 파일
def _is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _strip_mark(text: str) -> str:
    return "\n".join(l for l in text.splitlines() if MARK not in l) + "\n"


def restore_hosts() -> None:
    try:
        original = HOSTS_FILE.read_text(encoding="utf-8", errors="replace")
        if MARK in original:
            HOSTS_FILE.write_text(_strip_mark(original), encoding="utf-8")
        subprocess.run(["ipconfig", "/flushdns"], capture_output=True)
    except Exception as exc:
        print("hosts 복구 실패(수동으로 hosts 파일에서 'ezauto-capture' 줄을 지우세요):", exc)


def main() -> int:
    parser = argparse.ArgumentParser(description="이지오토 통신 캡처")
    parser.add_argument("--restore", action="store_true", help="hosts 파일 원상복구만 수행")
    parser.add_argument("--listen-port", type=int, default=80)
    parser.add_argument("--upstream", default="", help="테스트용: 원 서버를 host:port로 직접 지정 (지정하면 hosts를 건드리지 않는다)")
    args = parser.parse_args()

    if args.restore:
        if not _is_admin():
            print("관리자 권한 PowerShell에서 실행하세요.")
            return 1
        restore_hosts()
        print("hosts 복구 완료")
        return 0

    test_mode = bool(args.upstream)
    if not test_mode and not _is_admin():
        print("hosts 파일 수정을 위해 '관리자 권한' PowerShell에서 실행해야 합니다.")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if test_mode:
        host, _, port = args.upstream.partition(":")
        Relay.upstream = (host, int(port or 80))
    else:
        restore_hosts()  # 이전 잔여물 제거 후, 원래 IP를 먼저 조회
        real_ip = socket.gethostbyname(TARGET_HOST)
        Relay.upstream = (real_ip, 80)

    server = ThreadingHTTPServer(("127.0.0.1", args.listen_port), Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=_watch_connections, daemon=True).start()

    if not test_mode:
        original = HOSTS_FILE.read_text(encoding="utf-8", errors="replace")
        HOSTS_FILE.write_text(original.rstrip("\n") + f"\n127.0.0.1 {TARGET_HOST} {MARK}\n", encoding="utf-8")
        subprocess.run(["ipconfig", "/flushdns"], capture_output=True)
        atexit.register(restore_hosts)
        print(f"[준비 완료] {TARGET_HOST} -> 127.0.0.1 (원 서버 {Relay.upstream[0]})")
        print("1) 이지오토를 끄고 다시 켠 뒤, '자동발주'를 1회 실행하세요 (판매처 송장등록도 1회).")
        print("2) 끝나면 이 창에서 Ctrl+C. hosts 파일은 자동으로 원상복구됩니다.")
        print(f"3) 결과 요약: {OUT_DIR / 'summary.txt'}  (원문 raw.log는 개인정보가 있으니 공유 금지)")
    else:
        print(f"[테스트 모드] 127.0.0.1:{args.listen_port} -> {args.upstream}")

    try:
        while True:
            time.sleep(10)
            write_summary()
    except KeyboardInterrupt:
        pass
    finally:
        _stop.set()
        server.shutdown()
        write_summary()
        if not test_mode:
            restore_hosts()
        print(f"\n종료. 요약: {OUT_DIR / 'summary.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
