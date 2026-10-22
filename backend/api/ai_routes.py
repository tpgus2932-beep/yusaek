import json
import os
import re
import sqlite3
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse

OLLAMA_BASE = (os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL") or "qwen2.5:7b"

MAX_TOOL_ROUNDS = 4
MAX_HISTORY = 20
MAX_SQL_ROWS = 50
GUIDE_TOP_K = 3
GUIDE_SNIPPET_CHARS = 1500

# DB 질의 도구가 읽을 수 없는 테이블 (계정/비밀/토큰류)
BLOCKED_TABLES = {"users", "settings", "sessions", "tokens", "ezadmin_sessions"}
BLOCKED_COLUMN_HINTS = ("password", "token", "secret", "session", "api_key")

SYSTEM_PROMPT = """너는 YUSAEK 사내 업무 도우미 AI다. 항상 한국어로 간결하게 답한다.
- 업무 방법/규칙 질문은 먼저 search_guidebook 도구로 가이드북을 검색해 그 내용을 근거로 답한다. 근거가 없으면 모른다고 말한다.
- 데이터(건수, 목록 등) 질문은 list_tables / describe_table 로 구조를 확인한 뒤 query_db 로 SELECT 조회해서 답한다. 추측해서 숫자를 말하지 않는다.
- 데이터를 수정/삭제하거나 외부 시스템에 실행하는 작업은 아직 할 수 없다. 그런 요청은 해당 화면(탭)에서 직접 하도록 안내한다."""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_guidebook",
            "description": "사내 가이드북에서 키워드로 업무 방법/규칙 문서를 검색한다.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "검색 키워드"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tables",
            "description": "조회 가능한 DB 테이블 목록을 반환한다. (관리자 전용)",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "describe_table",
            "description": "테이블의 컬럼 목록을 반환한다. (관리자 전용)",
            "parameters": {
                "type": "object",
                "properties": {"table": {"type": "string"}},
                "required": ["table"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_db",
            "description": f"읽기 전용 SQL(SELECT 한 문장)을 실행한다. 최대 {MAX_SQL_ROWS}행. (관리자 전용)",
            "parameters": {
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"],
            },
        },
    },
]
DB_TOOLS = {"list_tables", "describe_table", "query_db"}


def _strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[0-9A-Za-z가-힣]+", (text or "").lower()) if len(t) >= 2]


def build_ai_router(*, get_db, get_current_user, is_admin, db_path: Path):
    router = APIRouter()

    # ── Tools ───────────────────────────────────────────────────────────────

    def _search_guidebook(query: str) -> str:
        words = _tokens(query)
        if not words:
            return "검색어가 비어 있습니다."
        conn = get_db()
        rows = conn.execute("SELECT title, content FROM guidebook_pages").fetchall()
        conn.close()
        scored = []
        for row in rows:
            title = (row["title"] or "").lower()
            body = _strip_html(row["content"]).lower()
            score = sum(3 * title.count(w) + body.count(w) for w in words)
            if score:
                scored.append((score, row["title"], _strip_html(row["content"])))
        scored.sort(key=lambda x: -x[0])
        if not scored:
            return "관련 가이드북 문서를 찾지 못했습니다."
        return "\n\n".join(
            f"[문서: {title}]\n{body[:GUIDE_SNIPPET_CHARS]}" for _, title, body in scored[:GUIDE_TOP_K]
        )

    def _open_readonly():
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        def authorizer(action, arg1, arg2, dbname, source):
            if action == sqlite3.SQLITE_READ:
                if (arg1 or "").lower() in BLOCKED_TABLES:
                    return sqlite3.SQLITE_DENY
                if any(h in (arg2 or "").lower() for h in BLOCKED_COLUMN_HINTS):
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE):
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY

        conn.set_authorizer(authorizer)
        return conn

    def _list_tables() -> str:
        conn = _open_readonly()
        try:
            names = [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
                if r[0].lower() not in BLOCKED_TABLES
            ]
        finally:
            conn.close()
        return ", ".join(names)

    def _describe_table(table: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]+", table or "") or table.lower() in BLOCKED_TABLES:
            return "조회할 수 없는 테이블입니다."
        conn = _open_readonly()
        try:
            cols = [
                f"{r[1]} {r[2]}"
                for r in conn.execute(f'PRAGMA table_info("{table}")')
                if not any(h in r[1].lower() for h in BLOCKED_COLUMN_HINTS)
            ]
        finally:
            conn.close()
        return ", ".join(cols) or "테이블이 없습니다."

    def _query_db(sql: str) -> str:
        sql = (sql or "").strip().rstrip(";")
        if ";" in sql or not re.match(r"(?is)^\s*(select|with)\b", sql):
            return "SELECT 한 문장만 실행할 수 있습니다."
        conn = _open_readonly()
        try:
            cur = conn.execute(sql)
            rows = cur.fetchmany(MAX_SQL_ROWS + 1)
            cols = [d[0] for d in cur.description or []]
        except sqlite3.Error as exc:
            return f"SQL 오류: {exc}"
        finally:
            conn.close()
        truncated = len(rows) > MAX_SQL_ROWS
        data = [dict(zip(cols, r)) for r in rows[:MAX_SQL_ROWS]]
        out = json.dumps(data, ensure_ascii=False, default=str)
        return out + (f"\n(최대 {MAX_SQL_ROWS}행까지만 표시됨)" if truncated else "")

    def _run_tool(name: str, args: dict, admin: bool) -> str:
        if name in DB_TOOLS and not admin:
            return "DB 조회는 관리자만 사용할 수 있습니다."
        try:
            if name == "search_guidebook":
                return _search_guidebook(str(args.get("query", "")))
            if name == "list_tables":
                return _list_tables()
            if name == "describe_table":
                return _describe_table(str(args.get("table", "")))
            if name == "query_db":
                return _query_db(str(args.get("sql", "")))
        except Exception as exc:  # 도구 오류는 모델에게 텍스트로 돌려준다
            return f"도구 실행 오류: {exc}"
        return f"알 수 없는 도구: {name}"

    # ── Routes ──────────────────────────────────────────────────────────────

    @router.get("/ai/status")
    async def ai_status(user: str = Depends(get_current_user)):
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                res = await client.get(f"{OLLAMA_BASE}/api/tags")
            models = [m.get("name") for m in res.json().get("models", [])]
        except Exception:
            return {"ok": False, "model": OLLAMA_MODEL, "installed": False, "models": []}
        return {
            "ok": True,
            "model": OLLAMA_MODEL,
            "installed": any(m == OLLAMA_MODEL or (m or "").startswith(OLLAMA_MODEL + ":") for m in models),
            "models": models,
        }

    @router.post("/ai/chat")
    async def ai_chat(payload: dict = Body(...), user: str = Depends(get_current_user)):
        raw = payload.get("messages") or []
        history = [
            {"role": m["role"], "content": str(m.get("content", ""))}
            for m in raw[-MAX_HISTORY:]
            if isinstance(m, dict) and m.get("role") in ("user", "assistant")
        ]
        if not history or history[-1]["role"] != "user":
            raise HTTPException(status_code=400, detail="messages must end with a user message")
        admin = bool(is_admin(user))
        tools = TOOLS if admin else [t for t in TOOLS if t["function"]["name"] not in DB_TOOLS]

        def sse(obj: dict) -> str:
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        async def stream():
            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5)) as client:
                    for _ in range(MAX_TOOL_ROUNDS + 1):
                        tool_calls = []
                        text = ""
                        async with client.stream(
                            "POST",
                            f"{OLLAMA_BASE}/api/chat",
                            json={"model": OLLAMA_MODEL, "messages": messages, "tools": tools, "stream": True},
                        ) as res:
                            if res.status_code != 200:
                                body = (await res.aread()).decode("utf-8", "ignore")[:300]
                                yield sse({"type": "error", "message": f"Ollama 오류 {res.status_code}: {body}"})
                                return
                            async for line in res.aiter_lines():
                                if not line:
                                    continue
                                msg = json.loads(line).get("message") or {}
                                if msg.get("content"):
                                    text += msg["content"]
                                    yield sse({"type": "token", "text": msg["content"]})
                                tool_calls.extend(msg.get("tool_calls") or [])
                        if not tool_calls:
                            yield sse({"type": "done"})
                            return
                        messages.append({"role": "assistant", "content": text, "tool_calls": tool_calls})
                        for call in tool_calls:
                            fn = call.get("function") or {}
                            name, args = fn.get("name", ""), fn.get("arguments") or {}
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except ValueError:
                                    args = {}
                            yield sse({"type": "tool", "name": name, "args": args})
                            messages.append({"role": "tool", "content": _run_tool(name, args, admin)})
                    yield sse({"type": "error", "message": "도구 호출 횟수 한도를 초과했습니다."})
            except httpx.ConnectError:
                yield sse({"type": "error", "message": "Ollama 서버에 연결할 수 없습니다. Ollama 설치/실행 여부를 확인하세요."})
            except Exception as exc:
                yield sse({"type": "error", "message": f"AI 처리 중 오류: {exc}"})

        return StreamingResponse(stream(), media_type="text/event-stream")

    return router
