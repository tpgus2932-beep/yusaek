"""Stop 훅: 코드가 바뀌었는데 개발 업데이트 기록(devUpdates.js)이 안 바뀌었으면 종료를 막는다."""
import json
import subprocess
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
if data.get("stop_hook_active"):  # 한 번 막았으면 무한 루프 방지
    sys.exit(0)

out = subprocess.run(
    ["git", "status", "--porcelain", "-uall"], capture_output=True, text=True, encoding="utf-8"
).stdout
paths = [line[3:].strip().strip('"') for line in out.splitlines() if len(line) > 3]
LOG = "src/data/devUpdates.js"
code = [p for p in paths if (p.startswith("src/") or p.startswith("backend/")) and p != LOG and "tests/" not in p]
if code and LOG not in paths:
    sys.stderr.write(
        "코드가 변경됐지만 개발 업데이트 기록이 없습니다. "
        "src/data/devUpdates.js 맨 위에 비개발자가 이해할 수 있는 한 줄을 추가하세요 (CLAUDE.md 규칙).\n"
    )
    sys.exit(2)
