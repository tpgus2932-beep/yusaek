"""내 PC 프린터 직접출력 에이전트.

웹앱(바코드 라벨 "내 PC 직접출력")이 이 PC의 localhost 로 라벨을 보내면
윈도우 프린터로 인쇄 대화상자 없이 바로 출력한다. 서버(백엔드)와 무관하게 이 PC에서만 동작한다.

실행:  python agent.py   (또는 빌드한 print_agent.exe)
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "services"))  # 소스 실행 시 label_printer 위치
import label_printer  # noqa: E402

PORT = int(os.getenv("PRINT_AGENT_PORT", "8765"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/printers":
            try:
                self._send(200, {"ok": True, **label_printer.list_printers()})
            except Exception as exc:
                self._send(500, {"ok": False, "detail": f"프린터 목록 조회 실패: {exc}"})
        elif self.path.split("?")[0] == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "detail": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/print-labels":
            self._send(404, {"ok": False, "detail": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            printed = label_printer.print_labels(payload.get("labels", []), str(payload.get("printer") or ""))
            self._send(200, {"ok": True, "printed": printed})
        except Exception as exc:
            self._send(500, {"ok": False, "detail": f"출력 실패: {exc}"})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    print(f"바코드 출력 에이전트 실행 중: http://127.0.0.1:{PORT}  (창을 닫으면 종료됩니다)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
