"""영수증 사진 -> (Windows OCR + ChatGPT) -> 상품 리스트 -> 원가베이스유 DB 매칭.

ChatGPT는 sample 프로젝트의 고스트워커와 같은 방식(전용 프로필 Chrome을 remote-debugging 9222로
띄워두고 Playwright로 붙기)으로 쓴다. 고스트워커의 탭을 건드리지 않도록 이 모듈은 항상 새 탭을 열어
쓰고 끝나면 닫는다. 한 번에 하나의 영수증만 처리한다(동시에 여러 탭이 한 계정으로 돌면 느려지고 꼬임).
"""
import base64
import io
import json
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

CDP_ENDPOINT = "http://127.0.0.1:9222"
CDP_VERSION_URL = f"{CDP_ENDPOINT}/json/version"
CHATGPT_URL = "https://chatgpt.com/"
GHOST_CHROME_PROFILE = r"C:\ghost-chrome-profile"
CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)

# ChatGPT UI 개편으로 #upload-photos / #prompt-textarea 가 사라지고 id가 매번 바뀌는 형태가 됐다(2026-10 실측) -
# 속성 기반 selector를 쓰고, 옛 id도 폴백으로 같이 허용한다.
SEL_UPLOAD_INPUT = "input[type='file'][accept='image/*'], #upload-photos"
SEL_PROMPT = "div.ProseMirror[role='textbox'], #prompt-textarea"
# 답변 본문은 data-chatgpt-selection-message-id 가 붙은 div에 들어 있다(2026-10 실측, 옛 data-message-author-role 은 없어짐).
SEL_ASSISTANT_MSG = "div[data-chatgpt-selection-message-id]"
SEL_STOP_BUTTON = "button[aria-label*='중지'], button[aria-label*='Stop'], button[data-testid='stop-button']"
RESPONSE_TIMEOUT_S = 240

_RECEIPT_PROMPT = """첨부한 영수증/거래명세서 사진에서 상품 목록을 추출해줘.
아래 OCR 텍스트는 사진에서 기계로 뽑은 것이라 오탈자가 있을 수 있어. 사진을 기준으로 하되 숫자/코드는 OCR 텍스트로 교차 확인해줘.

[OCR 텍스트]
{ocr_text}

규칙:
- 상품 한 줄(색상/사이즈가 다르면 다른 줄)당 객체 하나.
- 키: name(상품명 또는 품번. 줄 앞 번호("1.")와 변형/기장 표기(-A1, A1LONG, SH 등)는 뺀 앞부분. 예: "1.LC-7008-A1LONG/블랙/S" -> "LC-7008"),
  option(색상과 사이즈를 "/"로 이은 문자열. 예: "블랙/S"), length(기장: LONG=롱, SH=숏처럼 한글로. 표기 없으면 빈 문자열), qty(수량, 숫자)
- 금액/합계/전화번호/주소 같은 상품이 아닌 줄은 제외.
- 설명 없이 ```json 코드블록 안에 JSON 배열만 출력해.
"""

_jobs: dict = {}
_jobs_lock = threading.Lock()
_run_lock = threading.Lock()


def _cdp_up() -> bool:
    try:
        return httpx.get(CDP_VERSION_URL, timeout=1.5).status_code == 200
    except httpx.HTTPError:
        return False


def _find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    return ""


def ocr_image_bytes(data: bytes) -> str:
    """Windows 내장 OCR(한국어). 실패해도 사진만으로 진행할 수 있게 빈 문자열을 돌려준다."""
    try:
        import winocr
        from PIL import Image

        img = Image.open(io.BytesIO(data)).convert("RGB")
        return str(winocr.recognize_pil_sync(img, "ko").get("text") or "").strip()
    except Exception:
        return ""


def extract_json_list(text: str) -> list:
    """ChatGPT 답변에서 JSON 배열을 꺼내 [{name, option, length, qty}]로 정리한다."""
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("답변에서 JSON 목록을 찾지 못했습니다.")
    raw = json.loads(text[start:end + 1])
    items = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        name = str(r.get("name") or "").strip()
        if not name:
            continue
        try:
            qty = int(float(str(r.get("qty") or 0).replace(",", "")))
        except ValueError:
            qty = 0
        items.append({
            "name": name,
            "option": str(r.get("option") or "").strip(),
            "length": str(r.get("length") or "").strip(),
            "qty": qty,
        })
    return items


def _ask_chatgpt(image_path: str, prompt: str) -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        context = browser.contexts[0]
        context.grant_permissions(["clipboard-read", "clipboard-write"])
        page = context.new_page()
        try:
            page.goto(CHATGPT_URL)
            page.wait_for_timeout(2500)
            page.locator(SEL_UPLOAD_INPUT).first.set_input_files(image_path, timeout=30000)
            page.wait_for_timeout(2500)
            composer = page.locator(SEL_PROMPT).first
            composer.click()
            page.evaluate("text => navigator.clipboard.writeText(text)", prompt)
            page.keyboard.press("Control+A")
            page.keyboard.press("Control+V")
            page.wait_for_timeout(400)
            baseline = page.locator(SEL_ASSISTANT_MSG).count()
            composer.press("Enter")

            deadline = time.monotonic() + RESPONSE_TIMEOUT_S
            last_text, stable = "", 0
            while time.monotonic() < deadline:
                time.sleep(2)
                msgs = page.locator(SEL_ASSISTANT_MSG)
                if msgs.count() <= baseline:
                    continue
                text = msgs.last.inner_text()
                generating = page.locator(SEL_STOP_BUTTON).count() > 0
                if text and text == last_text and not generating:
                    stable += 1
                    if stable >= 2:
                        return text
                else:
                    stable = 0
                last_text = text
            raise TimeoutError(f"{RESPONSE_TIMEOUT_S}초 안에 ChatGPT 답변을 받지 못했습니다.")
        finally:
            page.close()


def build_receipt_router(*, get_current_user, get_db, get_wonbe_db):
    router = APIRouter(prefix="/receipt")

    def _init(conn):
        conn.execute(
            "CREATE TABLE IF NOT EXISTS receipt_matches ("
            " match_key TEXT PRIMARY KEY, product_code TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        conn.commit()

    def _key(item: dict) -> str:
        parts = [item.get("name", ""), item.get("option", ""), item.get("length", "")]
        return "|".join(re.sub(r"\s+", "", p).lower() for p in parts)

    def _row_tokens(row: dict) -> set:
        text = f"{row.get('색상') or ''} {row.get('사이즈') or ''}"
        return {t.lower() for t in re.split(r"[\s/()\-,]+", text) if t}

    def _token_ok(token: str, row: dict, tokens: set) -> bool:
        # 영문 사이즈(S/M/L/XL)는 부분 문자열로 비교하면 "L"이 "XL"에 걸리므로 토큰 단위로만 비교한다.
        t = token.lower()
        if t in tokens:
            return True
        return not token.isascii() and token in f"{row.get('색상') or ''} {row.get('사이즈') or ''}"

    def _wonbe_candidates(item: dict, ignore_color: bool = False) -> list:
        """품번/상품명으로 후보를 좁힌 뒤 색상·사이즈·기장을 토큰 단위로 대조한다.
        기장이 영수증에 없으면 롱/숏 행은 (다른 후보가 남는 한) 제외한다."""
        name_words = item["name"].split()
        opt_words = [w for w in re.split(r"[\s/,]+", item["option"]) if w]
        length = item["length"].strip()
        if not name_words:
            return []
        cols = ["상품명합", "거래처상품명", "상품명", "상품코드"]
        clause = " AND ".join("(" + " OR ".join(f"{c} LIKE ?" for c in cols) + ")" for _ in name_words)
        params = [f"%{w}%" for w in name_words for _ in cols]
        conn = get_wonbe_db()
        try:
            rows = [dict(r) for r in conn.execute(
                f"SELECT 상품코드, 상품명, 상품명합, 거래처상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE {clause} LIMIT 500",
                params,
            ).fetchall()]
        finally:
            conn.close()
        # ignore_color: 영수증 색상명이 DB와 다를 때(예: 딥브라운 vs (기모)브라운) 사이즈/기장만 맞는 후보를 보여준다.
        need = (opt_words[1:] if ignore_color else opt_words) + ([length] if length else [])
        found = [r for r in rows if all(_token_ok(w, r, _row_tokens(r)) for w in need)]
        if not length and len(found) > 1:
            plain = [r for r in found if not ({"롱", "숏", "long", "sh"} & _row_tokens(r))]
            found = plain or found
        return found[:10]

    def _match_items(items: list) -> list:
        conn = get_db()
        try:
            _init(conn)
            known = {
                r["match_key"]: r["product_code"]
                for r in conn.execute("SELECT match_key, product_code FROM receipt_matches").fetchall()
            }
        finally:
            conn.close()
        out = []
        for item in items:
            key = _key(item)
            entry = dict(item, match_key=key, product_code="", candidates=[], matched_before=False)
            if key in known:
                # 이미 매칭해 둔 항목은 DB를 다시 검색하지 않는다.
                entry.update(product_code=known[key], matched_before=True)
                # 화면에 거래처상품명/옵션을 보여주려고 해당 코드의 행만 한 번 읽는다(검색은 아님).
                conn = get_wonbe_db()
                try:
                    row = conn.execute(
                        "SELECT 상품코드, 상품명, 상품명합, 거래처상품명, 색상, 사이즈, 거래처 FROM wonbe WHERE 상품코드 = ?",
                        (known[key],),
                    ).fetchone()
                finally:
                    conn.close()
                if row:
                    entry["candidates"] = [dict(row)]
            else:
                entry["candidates"] = _wonbe_candidates(item)
                if len(entry["candidates"]) == 1:
                    entry["product_code"] = entry["candidates"][0]["상품코드"]
                elif not entry["candidates"]:
                    # 후보가 전혀 없을 때만 색상을 빼고 찾는다 - 자동 확정은 하지 않고 사람이 고르게 한다.
                    entry["candidates"] = _wonbe_candidates(item, ignore_color=True)
                    entry["fuzzy"] = True
            out.append(entry)
        return out

    def _save_match(key: str, code: str):
        conn = get_db()
        try:
            _init(conn)
            conn.execute(
                "INSERT INTO receipt_matches (match_key, product_code, created_at) VALUES (?,?,?) "
                "ON CONFLICT(match_key) DO UPDATE SET product_code=excluded.product_code",
                (key, code, datetime.now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()

    def _run_job(job_id: str, image_bytes: bytes):
        def update(**kw):
            with _jobs_lock:
                _jobs[job_id].update(kw)

        tmp_path = os.path.join(os.environ.get("TEMP", "."), f"receipt_{job_id}.png")
        try:
            with _run_lock:
                update(status="running", step="OCR")
                ocr_text = ocr_image_bytes(image_bytes)
                with open(tmp_path, "wb") as f:
                    f.write(image_bytes)
                update(step="ChatGPT 분석 중", ocr_chars=len(ocr_text))
                answer = _ask_chatgpt(tmp_path, _RECEIPT_PROMPT.format(ocr_text=ocr_text or "(OCR 결과 없음)"))
            update(step="DB 매칭 중")
            update(status="done", step="완료", items=_match_items(extract_json_list(answer)))
        except Exception as exc:
            update(status="failed", error=f"{type(exc).__name__}: {exc}")
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    @router.get("/ghost/status")
    def ghost_status(user: str = Depends(get_current_user)):
        return {"ok": True, "running": _cdp_up()}

    @router.post("/ghost/launch")
    def ghost_launch(user: str = Depends(get_current_user)):
        if _cdp_up():
            return {"ok": True, "running": True, "already": True}
        chrome = _find_chrome()
        if not chrome:
            raise HTTPException(status_code=500, detail="Chrome 실행 파일을 찾지 못했습니다.")
        subprocess.Popen([
            chrome,
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9222",
            f"--user-data-dir={GHOST_CHROME_PROFILE}",
            CHATGPT_URL,
        ])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if _cdp_up():
                return {"ok": True, "running": True, "already": False}
            time.sleep(1)
        raise HTTPException(status_code=504, detail="Chrome(9222)이 30초 안에 뜨지 않았습니다.")

    @router.post("/parse")
    def parse_receipt(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """payload.image: 영수증 사진의 data URL 또는 base64 문자열."""
        raw = str(payload.get("image") or "")
        if "," in raw[:100]:
            raw = raw.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(raw, validate=False)
        except Exception:
            raise HTTPException(status_code=400, detail="이미지를 읽을 수 없습니다.")
        if not image_bytes:
            raise HTTPException(status_code=400, detail="이미지가 비어 있습니다.")
        if not _cdp_up():
            raise HTTPException(status_code=409, detail="고스트워커(Chrome 9222)가 실행 중이 아닙니다. '고스트워커 실행'을 먼저 누르세요.")
        job_id = uuid.uuid4().hex
        with _jobs_lock:
            _jobs[job_id] = {"status": "queued", "step": "대기", "items": [], "error": ""}
        threading.Thread(target=_run_job, args=(job_id, image_bytes), daemon=True).start()
        return {"ok": True, "job_id": job_id}

    @router.get("/parse/{job_id}")
    def parse_status(job_id: str, user: str = Depends(get_current_user)):
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
            return {"ok": True, **job}

    @router.post("/match")
    def save_match(payload: dict = Body(...), user: str = Depends(get_current_user)):
        key = str(payload.get("match_key") or "").strip()
        code = str(payload.get("product_code") or "").strip()
        if not key or not code:
            raise HTTPException(status_code=400, detail="match_key와 product_code가 필요합니다.")
        _save_match(key, code)
        return {"ok": True}

    router.match_items = _match_items  # 매칭 로직만 따로 검증할 수 있게 노출
    return router
