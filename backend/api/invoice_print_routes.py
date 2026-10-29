from __future__ import annotations

import json
import random
import re
import uuid
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

_EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
_EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
_EZ_EXTRA_COOKIES = {"ezdomain": "yusaek", "ezuserid": "yusaek", "ezsave": "on"}
_EZ_TIMEOUT = 300.0
_KST = ZoneInfo("Asia/Seoul")
_DEFAULT_SHOP_CODE = "10028"
_LOOKBACK_DAYS = 91
_MAX_PRINT_COUNT = 1000
_TRANS_TEMPLATE = "20004"
_PRODUCT_CODE_RE = re.compile(r"^\s*\[[^\]]*\]")


def init_invoice_print_tables(get_db):
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoice_print_job (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                filters_json TEXT NOT NULL DEFAULT '',
                chunk_size INTEGER NOT NULL DEFAULT 1,
                rows_json TEXT NOT NULL DEFAULT '[]',
                created_by TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoice_print_chunk (
                job_id TEXT NOT NULL,
                chunk_no INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                claimed_by TEXT NOT NULL DEFAULT '',
                claim_token TEXT NOT NULL DEFAULT '',
                html_url TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (job_id, chunk_no)
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def build_invoice_print_router(*, get_current_user, get_setting, get_db):
    router = APIRouter(prefix="/invoice-print")

    def _headers() -> dict:
        return {
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": _EZADMIN_BASE,
            "Referer": f"{_EZADMIN_BASE}/template35.htm?template=S700",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
        }

    def _cookies() -> dict | None:
        phpsessid = (get_setting(_EZADMIN_SESSION_KEY) or "").strip()
        if not phpsessid:
            return None
        return {"PHPSESSID": phpsessid, **_EZ_EXTRA_COOKIES}

    async def _ez_post(client: httpx.AsyncClient, cookies: dict, form: dict) -> httpx.Response:
        try:
            return await client.post(f"{_EZADMIN_BASE}/function.htm", headers=_headers(), cookies=cookies, data=form)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"이지어드민 응답 오류: {type(e).__name__} {e}".strip())

    def _now_iso() -> str:
        return datetime.now(_KST).replace(tzinfo=None, microsecond=0).isoformat(sep=" ")

    def _list_par(f: dict, now: datetime) -> str:
        def flag(key: str, default: bool) -> str:
            return "1" if bool(f.get(key, default)) else "0"

        def date_or(key: str, fallback: datetime) -> str:
            v = str(f.get(key) or "").strip()
            return v if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) else fallback.strftime("%Y-%m-%d")

        shop_code = re.sub(r"[^0-9]", "", str(f.get("shop_code") or _DEFAULT_SHOP_CODE)) or _DEFAULT_SHOP_CODE
        start = date_or("start_date", now - timedelta(days=_LOOKBACK_DAYS))
        end = date_or("end_date", now)
        product_type = "code" if f.get("product_type") == "code" else "name"
        product_text = quote(str(f.get("product_text") or "").strip(), safe="")
        part_count = re.sub(r"[^0-9]", "", str(f.get("part_count") or ""))
        return (
            f"cs=0&status=1&type=0&dateType=0&start_date2={start}&start_hour2=00&end_date2={end}&end_hour2=23"
            f"&date_period_sel2=9&search_product_type={product_type}&txt_search_product={product_text}&tag_string="
            f"&priorityDeliv={flag('priority_deliv', True)}"
            f"&multi_shop_group=&multi_shop=&str_shop_code={shop_code}&shop_group=0"
            f"&partTrans={flag('part_trans', True)}&partCount={part_count}"
            f"&price_type=part&part_deliv_price=&orderReserve={flag('order_reserve', True)}&multi_supply_group=&multi_supply="
            f"&str_supply_code=0&s_group_id=&part_deliv_cnt=0&check_expect_date=&user_area=&labels_string="
            f"&include_type=1&is_download=0&orderType=1&agencyTemplate={_TRANS_TEMPLATE}&check_address=2"
            f"&teamf_transType=tonight&kakaoT_type=0&deliv_today_type=0&hanjin_deliv_type=GN&joongang_svc_type=null"
        )

    async def _fetch_orders(filters: dict) -> list[dict] | None:
        """이지어드민 주문 리스트를 상품명 오름차순으로 가져온다. 세션이 없거나 만료면 None."""
        cookies = _cookies()
        if not cookies:
            return None
        now = datetime.now(_KST)
        async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
            # 화면 진입 시 이지어드민이 먼저 보내는 예약발주 모드 전환 (세션 상태를 맞춘다)
            await _ez_post(client, cookies, {
                "template": "S700", "action": "change_orderReserve",
                "par": f"pre_deliv={'1' if filters.get('order_reserve', True) else '0'}",
            })
            res = await _ez_post(client, cookies, {
                "_search": "false", "nd": str(int(now.timestamp() * 1000)), "rows": "999999", "page": "1",
                "sidx": "", "sord": "asc", "readonly": "T", "template": "S700", "action": "get_success_order",
                "par": _list_par(filters, now),
            })
        try:
            data = res.json()
        except Exception:
            return None
        rows = []
        for item in data.get("rows", []):
            cell = item.get("cell", {})
            seq = str(cell.get("seq") or "").strip()
            if not seq:
                continue
            rows.append({
                "rowid": item.get("id"),
                "seq": seq,
                "shop_name": cell.get("shop_name", ""),
                "recv_name": cell.get("recv_name", ""),
                "recv_address": cell.get("recv_address", ""),
                "products": cell.get("products", ""),
                "product_name": str(cell.get("product_name") or "").strip(),
                "options": str(cell.get("options") or "").strip(),
                "trans_no": str(cell.get("trans_no") or "").strip(),
            })
        # 상품명 오름차순(앞의 [상품코드]는 빼고 비교), 같으면 주문번호 순, 그것도 같으면 옵션 순. 합배송은 첫 상품 기준.
        rows.sort(key=lambda r: (
            _PRODUCT_CODE_RE.sub("", r["product_name"] or r["products"], count=1).strip(),
            int(r["seq"]) if r["seq"].isdigit() else 0,
            r["options"],
        ))
        return rows

    def _chunk_ranges(total: int, size: int) -> list[tuple[int, int]]:
        return [(i, min(i + size, total)) for i in range(0, total, size)]

    def _load_job(conn, job_id: str) -> dict:
        row = conn.execute("SELECT * FROM invoice_print_job WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
        return {
            "id": row["id"], "title": row["title"], "chunk_size": row["chunk_size"],
            "created_by": row["created_by"], "created_at": row["created_at"],
            "filters": json.loads(row["filters_json"] or "{}"), "rows": json.loads(row["rows_json"] or "[]"),
        }

    def _chunk_state(conn, job_id: str) -> dict[int, dict]:
        out = {}
        for r in conn.execute(
            "SELECT chunk_no, status, claimed_by, html_url, updated_at FROM invoice_print_chunk WHERE job_id = ?", (job_id,)
        ).fetchall():
            out[r["chunk_no"]] = {
                "status": r["status"], "claimed_by": r["claimed_by"], "html_url": r["html_url"], "updated_at": r["updated_at"],
            }
        return out

    def _job_view(conn, job: dict, with_rows: bool) -> dict:
        rows = job["rows"]
        states = _chunk_state(conn, job["id"])
        chunks = []
        for no, (a, b) in enumerate(_chunk_ranges(len(rows), job["chunk_size"])):
            st = states.get(no, {})
            items = rows[a:b]
            chunks.append({
                "no": no, "start": a + 1, "end": b, "count": len(items),
                "pending_count": sum(1 for r in items if not r["trans_no"]),
                "status": st.get("status", "pending"), "claimed_by": st.get("claimed_by", ""),
                "updated_at": st.get("updated_at", ""),
            })
        view = {
            "id": job["id"], "title": job["title"], "chunk_size": job["chunk_size"], "created_by": job["created_by"],
            "created_at": job["created_at"], "filters": job["filters"], "total": len(rows), "chunks": chunks,
        }
        if with_rows:
            view["rows"] = rows
        return view

    def _chunk_rows(job: dict, chunk_no: int) -> list[dict]:
        ranges = _chunk_ranges(len(job["rows"]), job["chunk_size"])
        if chunk_no < 0 or chunk_no >= len(ranges):
            raise HTTPException(status_code=404, detail="구간을 찾을 수 없습니다.")
        a, b = ranges[chunk_no]
        return job["rows"][a:b]

    _PAGE_NO_RE = re.compile(r">(\s*)\[\s*\d+\s*/\s*\d+\s*\](\s*)<")

    def _renumber_html(html: str, job: dict, chunk_no: int) -> str:
        """우측 상단 '[ n / 전체 ]'를 구간별 1부터가 아니라 작업 전체 기준 번호로 바꾼다. (1~50, 51~100 …)"""
        a, b = _chunk_ranges(len(job["rows"]), job["chunk_size"])[chunk_no]
        positions = [a + i + 1 for i, r in enumerate(job["rows"][a:b]) if not r["trans_no"]]
        total = len(job["rows"])
        found = len(_PAGE_NO_RE.findall(html))
        if found == len(positions):
            nums = iter(positions)
            return _PAGE_NO_RE.sub(lambda m: f">{m.group(1)}[ {next(nums)} / {total} ]{m.group(2)}<", html)
        # 송장 장수와 주문 수가 다르면(부분배송 등) 구간 시작 위치에 이지어드민의 구간 내 번호를 더한다.
        print(f"[invoice-print] 번호 개수 불일치: html {found}개 / 주문 {len(positions)}건 (job={job['id']}, chunk={chunk_no})")
        def shift(m):
            n = int(re.search(r"\d+", m.group(0)).group())
            return f">{m.group(1)}[ {a + n} / {total} ]{m.group(2)}<"

        return _PAGE_NO_RE.sub(shift, html)

    @router.post("/jobs")
    async def create_job(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """검색 조건으로 주문을 불러와 서버에 작업으로 저장한다. 다른 PC도 이 작업을 열어 구간을 나눠 출력한다."""
        filters = {k: v for k, v in payload.items() if k not in ("chunk_size", "pc_count")}
        rows = await _fetch_orders(filters)
        if rows is None:
            return {"ok": False, "need_session": True}
        if not rows:
            return {"ok": False, "detail": "검색 결과가 없습니다."}
        try:
            size = int(payload.get("chunk_size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size <= 0:
            try:
                pc = max(1, int(payload.get("pc_count") or 1))
            except (TypeError, ValueError):
                pc = 1
            size = -(-len(rows) // pc)
        job_id = uuid.uuid4().hex[:10]
        now = _now_iso()
        title = f"{now[5:16]} · {len(rows)}건 · {user}"
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO invoice_print_job (id, title, filters_json, chunk_size, rows_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (job_id, title, json.dumps(filters, ensure_ascii=False), size, json.dumps(rows, ensure_ascii=False), user, now),
            )
            for no in range(len(_chunk_ranges(len(rows), size))):
                conn.execute(
                    "INSERT INTO invoice_print_chunk (job_id, chunk_no, status, updated_at) VALUES (?, ?, 'pending', ?)",
                    (job_id, no, now),
                )
            conn.commit()
            return {"ok": True, "job": _job_view(conn, _load_job(conn, job_id), with_rows=True)}
        finally:
            conn.close()

    @router.get("/jobs")
    def list_jobs(user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            cutoff = (datetime.now(_KST) - timedelta(days=3)).replace(tzinfo=None).isoformat(sep=" ")
            ids = [r["id"] for r in conn.execute(
                "SELECT id FROM invoice_print_job WHERE created_at >= ? ORDER BY created_at DESC LIMIT 20", (cutoff,)
            ).fetchall()]
            jobs = []
            for jid in ids:
                view = _job_view(conn, _load_job(conn, jid), with_rows=False)
                view["done_count"] = sum(c["count"] for c in view["chunks"] if c["status"] in ("issued", "done"))
                jobs.append(view)
            return {"ok": True, "jobs": jobs}
        finally:
            conn.close()

    @router.get("/jobs/{job_id}")
    def get_job(job_id: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            return {"ok": True, "job": _job_view(conn, _load_job(conn, job_id), with_rows=True)}
        finally:
            conn.close()

    @router.delete("/jobs/{job_id}")
    def delete_job(job_id: str, user: str = Depends(get_current_user)):
        conn = get_db()
        try:
            conn.execute("DELETE FROM invoice_print_chunk WHERE job_id = ?", (job_id,))
            conn.execute("DELETE FROM invoice_print_job WHERE id = ?", (job_id,))
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    @router.post("/jobs/{job_id}/chunks/{chunk_no}/print")
    async def print_chunk(job_id: str, chunk_no: int, user: str = Depends(get_current_user)):
        """구간을 선점하고 송장번호를 발급해 출력용 HTML을 돌려준다. (송장번호 발급은 되돌릴 수 없다)"""
        cookies = _cookies()
        if not cookies:
            return {"ok": False, "need_session": True}
        conn = get_db()
        try:
            job = _load_job(conn, job_id)
            items = [r for r in _chunk_rows(job, chunk_no) if not r["trans_no"]]
            if not items:
                raise HTTPException(status_code=400, detail="이 구간에는 출력할 주문이 없습니다.")
            if len(items) > _MAX_PRINT_COUNT:
                raise HTTPException(status_code=400, detail=f"한 구간은 {_MAX_PRINT_COUNT}건까지만 출력할 수 있습니다.")
            # 선점: pending일 때만 내 토큰으로 바꾸고, 다시 읽어 내 토큰이면 내가 잡은 것이다.
            token = uuid.uuid4().hex
            conn.execute(
                "UPDATE invoice_print_chunk SET status = 'issuing', claimed_by = ?, claim_token = ?, updated_at = ? "
                "WHERE job_id = ? AND chunk_no = ? AND status = 'pending'",
                (user, token, _now_iso(), job_id, chunk_no),
            )
            conn.commit()
            cur = conn.execute(
                "SELECT status, claimed_by, claim_token FROM invoice_print_chunk WHERE job_id = ? AND chunk_no = ?",
                (job_id, chunk_no),
            ).fetchone()
            if not cur or cur["claim_token"] != token:
                who = cur["claimed_by"] if cur else ""
                raise HTTPException(status_code=409, detail=f"이미 {who or '다른 PC'}에서 출력 중이거나 출력한 구간입니다.")
        finally:
            conn.close()

        def release():
            c = get_db()
            try:
                c.execute(
                    "UPDATE invoice_print_chunk SET status = 'pending', claimed_by = '', claim_token = '', updated_at = ? "
                    "WHERE job_id = ? AND chunk_no = ? AND claim_token = ?",
                    (_now_iso(), job_id, chunk_no, token),
                )
                c.commit()
            finally:
                c.close()

        now = datetime.now(_KST)
        seqs = [r["seq"] for r in items]
        form = {
            "new_trans_no": "1", "use_range_print": "0", "is_pre_print": "0", "current_tab": "1",
            "search_status": "1", "template": "S700", "action": "make_html2", "trans_template": _TRANS_TEMPLATE,
            "arr_seq": json.dumps(seqs), "arr_rowid": json.dumps([str(r["rowid"]) for r in items]),
            "arr_qty": json.dumps([1] * len(seqs)), "arr_status": json.dumps([1] * len(seqs)),
            "box_type": "", "trans_slot_date": "", "trans_slot_time": "15:00:00",
            "hanjin_deliv_type": "GN", "joongang_svc_type": "null", "kakaoT_type": "0",
            "deliv_today_type": "0", "teamf_is_premium": "x", "teamf_transType": "tonight",
            "test_lotte": "0", "is_print": "1", "check_address": "2",
            "search_key": now.strftime("%Y%m%d%H%M%S") + f"{random.randint(0, 999999):06d}",
            "cj_box_sheet_seq": "0", "use_safe_number": "0",
        }
        try:
            async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
                res = await _ez_post(client, cookies, form)
                body = res.text
                marker = "result_print2("
                idx = body.find(marker)
                if idx < 0:
                    release()
                    if "login" in body.lower()[:2000]:
                        return {"ok": False, "need_session": True}
                    return {"ok": False, "detail": "이지어드민에서 송장 출력 결과를 받지 못했습니다. 세션 또는 주문 상태를 확인하세요."}
                try:
                    result, _ = json.JSONDecoder().raw_decode(body[idx + len(marker):])
                except ValueError:
                    release()
                    raise HTTPException(status_code=502, detail="이지어드민 출력 응답을 해석하지 못했습니다.")
                printed = result.get("print") or {}
                url = printed.get("url") or ""
                if printed.get("error") or not url.startswith(_EZADMIN_BASE):
                    release()
                    raise HTTPException(status_code=502, detail=f"이지어드민 송장 출력 실패: {printed}")
                # 여기부터는 송장번호가 이미 발급된 상태이므로 release하지 않고 issued로 기록한다.
                c = get_db()
                try:
                    c.execute(
                        "UPDATE invoice_print_chunk SET status = 'issued', html_url = ?, updated_at = ? "
                        "WHERE job_id = ? AND chunk_no = ? AND claim_token = ?",
                        (url, _now_iso(), job_id, chunk_no, token),
                    )
                    c.commit()
                finally:
                    c.close()
                try:
                    html_res = await client.get(url, headers=_headers(), cookies=cookies)
                except Exception as e:
                    raise HTTPException(status_code=502, detail=f"송장 HTML 조회 실패(재출력으로 다시 시도하세요): {type(e).__name__} {e}".strip())
        except HTTPException:
            raise
        except Exception:
            release()
            raise
        return {"ok": True, "html": _renumber_html(html_res.text, job, chunk_no), "count": len(seqs)}

    @router.post("/jobs/{job_id}/chunks/{chunk_no}/reprint")
    async def reprint_chunk(job_id: str, chunk_no: int, user: str = Depends(get_current_user)):
        """이미 발급된 구간의 출력용 HTML만 다시 가져온다. (송장번호를 새로 발급하지 않는다)"""
        cookies = _cookies()
        if not cookies:
            return {"ok": False, "need_session": True}
        conn = get_db()
        try:
            job = _load_job(conn, job_id)
            st = _chunk_state(conn, job_id).get(chunk_no)
        finally:
            conn.close()
        if not st or st["status"] not in ("issued", "done") or not st["html_url"]:
            raise HTTPException(status_code=400, detail="아직 송장이 발급되지 않은 구간입니다.")
        async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
            try:
                res = await client.get(st["html_url"], headers=_headers(), cookies=cookies)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"송장 HTML 조회 실패: {type(e).__name__} {e}".strip())
        return {"ok": True, "html": _renumber_html(res.text, job, chunk_no)}

    @router.post("/jobs/{job_id}/chunks/{chunk_no}/done")
    async def done_chunk(job_id: str, chunk_no: int, user: str = Depends(get_current_user)):
        cookies = _cookies()
        if not cookies:
            return {"ok": False, "need_session": True}
        conn = get_db()
        try:
            job = _load_job(conn, job_id)
            st = _chunk_state(conn, job_id).get(chunk_no)
        finally:
            conn.close()
        if not st or st["status"] not in ("issued", "done"):
            raise HTTPException(status_code=400, detail="송장이 발급된 구간만 출력 완료 처리할 수 있습니다.")
        seqs = [r["seq"] for r in _chunk_rows(job, chunk_no) if not r["trans_no"]]
        async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
            res = await _ez_post(client, cookies, {"template": "S700", "action": "set_pos_all", "par": ",".join(seqs)})
        try:
            data = res.json()
        except Exception:
            raise HTTPException(status_code=502, detail="출력 완료 표시 응답을 해석하지 못했습니다.")
        if data.get("error"):
            return {"ok": False, "detail": f"출력 완료 표시 실패: {data}"}
        conn = get_db()
        try:
            conn.execute(
                "UPDATE invoice_print_chunk SET status = 'done', updated_at = ? WHERE job_id = ? AND chunk_no = ?",
                (_now_iso(), job_id, chunk_no),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    async def _find_packs_by_trans_no(client, cookies, trans_no: str) -> list[str]:
        """송장번호로 이지어드민 주문(E900)을 검색해 주문 seq(pack) 목록을 돌려준다."""
        now = datetime.now(_KST)
        par = (
            "pack=&history_seq=&date_type=collect_date"
            f"&start_date={(now - timedelta(days=_LOOKBACK_DAYS)).strftime('%Y-%m-%d')}&end_date={now.strftime('%Y-%m-%d')}"
            "&date_period_sel=0&search_type=0&keyword=&keyword1=&keyword2=&keyword3=&keyword4=&keyword5="
            f"&super_keyword={trans_no}&order_status=-1&order_cs=0&query_trans_who=0&is_gift=0&work_type=0"
            "&labels_string=&checkbox_options_string="
        )
        res = await _ez_post(client, cookies, {
            "_search": "false", "nd": str(int(now.timestamp() * 1000)), "rows": "10", "page": "1",
            "sidx": "", "sord": "desc", "readonly": "T", "template": "E900", "action": "query_json", "par": par,
        })
        try:
            data = res.json()
        except Exception:
            raise HTTPException(status_code=502, detail="이지어드민 주문 검색 응답을 해석하지 못했습니다. 세션을 확인하세요.")
        packs: list[str] = []
        for item in data.get("rows", []):
            pack = str((item.get("cell") or {}).get("pack") or "").strip()
            if pack and pack not in packs:
                packs.append(pack)
        return packs

    @router.post("/reissue")
    async def reissue_by_trans_no(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """송장번호(여러 개 가능)로 주문을 찾아 같은 송장번호로 출력용 HTML을 다시 만든다. 번호는 새로 발급하지 않는다.
        이지어드민 수동 절차와 같다: 배송처리 취소(cancel_trans) → make_html_E900(new_trans_no=0) → 배송처리(confirm_trans).
        취소한 주문은 출력 성공/실패와 관계없이 마지막에 반드시 다시 배송처리한다."""
        cookies = _cookies()
        if not cookies:
            return {"ok": False, "need_session": True}
        raw = payload.get("trans_nos") or []
        if isinstance(raw, str):
            raw = re.split(r"[\s,;]+", raw)
        trans_nos = list(dict.fromkeys(re.sub(r"\D", "", str(x)) for x in raw if re.sub(r"\D", "", str(x))))
        if not trans_nos:
            raise HTTPException(status_code=400, detail="송장번호를 입력하세요.")
        if len(trans_nos) > 200:
            raise HTTPException(status_code=400, detail="한 번에 200건까지만 재출력할 수 있습니다.")

        def tf() -> str:
            return str(int(datetime.now(_KST).timestamp() * 1000))

        missing: list[str] = []
        seqs: list[str] = []
        async with httpx.AsyncClient(timeout=_EZ_TIMEOUT, verify=False, follow_redirects=True) as client:
            for no in trans_nos:
                packs = await _find_packs_by_trans_no(client, cookies, no)
                if not packs:
                    missing.append(no)
                for p in packs:
                    if p not in seqs:
                        seqs.append(p)
            if not seqs:
                return {"ok": False, "detail": "송장번호에 해당하는 주문을 찾지 못했습니다.", "missing": missing}

            canceled: list[str] = []
            cancel_failed: list[str] = []
            for seq in seqs:
                res = await _ez_post(client, cookies, {
                    "template": "E900", "action": "cancel_trans", "seq": seq, "content": "", "timeFlag": tf(),
                })
                try:
                    ok = not res.json().get("error")
                except Exception:
                    ok = False
                (canceled if ok else cancel_failed).append(seq)

            html = ""
            detail = ""
            try:
                if canceled:
                    n = len(canceled)
                    res = await _ez_post(client, cookies, {
                        "is_pre_print": "0", "new_trans_no": "0", "current_tab": "0", "template": "S700",
                        "action": "make_html_E900", "trans_template": _TRANS_TEMPLATE, "use_safe_number": "0",
                        "arr_seq": json.dumps(canceled), "arr_rowid": json.dumps(list(range(1, n + 1))),
                        "arr_qty": json.dumps([1] * n), "box_type": "", "print_page": "E900",
                        "trans_slot_date": "", "trans_slot_time": "15:00:00", "teamf_is_premium": "x",
                        "teamf_transType": "tonight", "teamf_box_add": "0", "kakaoT_type": "0",
                        "hanjin_deliv_type": "GN", "deliv_today_type": "0", "joongang_svc_type": "",
                    })
                    body = res.text
                    try:
                        result = res.json()
                    except Exception:
                        idx = body.find("result_print2(")
                        result = json.JSONDecoder().raw_decode(body[idx + len("result_print2("):])[0] if idx >= 0 else {}
                    printed = result.get("print") or {}
                    url = printed.get("url") or ""
                    if printed.get("error") or not url.startswith(_EZADMIN_BASE):
                        detail = f"이지어드민 송장 출력 실패: {printed or body[:200]}"
                    else:
                        html_res = await client.get(url, headers=_headers(), cookies=cookies)
                        html = html_res.text
            except HTTPException as e:
                detail = str(e.detail)
            except Exception as e:
                detail = f"{type(e).__name__} {e}".strip()
            finally:
                confirm_failed: list[str] = []
                for seq in canceled:
                    try:
                        res = await _ez_post(client, cookies, {
                            "template": "E900", "action": "confirm_trans", "seq": seq, "trans_type": "",
                            "trans_date": "", "cs_type": "", "content": "", "timeFlag": tf(),
                        })
                        if res.json().get("error"):
                            confirm_failed.append(seq)
                    except Exception:
                        confirm_failed.append(seq)

        out = {
            "ok": bool(html), "html": html, "count": len(canceled), "missing": missing,
            "cancel_failed": cancel_failed, "confirm_failed": confirm_failed,
        }
        if not html:
            out["detail"] = detail or "재출력할 주문이 없습니다."
        return out

    @router.post("/jobs/{job_id}/chunks/{chunk_no}/release")
    def release_chunk(job_id: str, chunk_no: int, user: str = Depends(get_current_user)):
        """발급 도중 멈춰 있는('issuing') 구간만 다시 풀어준다. 발급된 구간은 풀 수 없다."""
        conn = get_db()
        try:
            conn.execute(
                "UPDATE invoice_print_chunk SET status = 'pending', claimed_by = '', claim_token = '', updated_at = ? "
                "WHERE job_id = ? AND chunk_no = ? AND status = 'issuing'",
                (_now_iso(), job_id, chunk_no),
            )
            conn.commit()
            return {"ok": True}
        finally:
            conn.close()

    return router
