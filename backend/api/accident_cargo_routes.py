from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

TRB_BASE = "https://trb.alps.llogis.com:18230"
LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_PRINCIPAL = "348867"
LLOGIS_CREDENTIAL = "1q2w3e4r5t"


def build_accident_cargo_router(*, get_current_user, get_db):
    router = APIRouter(prefix="/accident-cargo")

    async def _login() -> str:
        async with httpx.AsyncClient(verify=False, timeout=15.0) as c:
            res = await c.post(
                LLOGIS_LOGIN_URL,
                json={
                    "principal": LLOGIS_PRINCIPAL,
                    "credential": LLOGIS_CREDENTIAL,
                    "macAddress": "normal-browser",
                },
            )
            res.raise_for_status()
        token = res.json().get("accessToken")
        if not token:
            raise HTTPException(502, "llogis 로그인 실패")
        return token

    async def _fetch_accident_data(token: str, date_fr: str, date_to: str) -> list:
        filter_obj = {
            "srchReqYmd": "requird:true",
            "srchCustSctCd": "10",
            "srchReqCustCd": "329673",
            "srchAcdTypCd": "10,20,30,40,50,60,90",
            "srchInvNo": "",
            "srchYmdFr": date_fr,
            "_STATUS_": "U",
            "srchYmdTo": date_to,
            "srchYmd": "A2.RGST_YMD",
            "srchNo": "A2.INV_NO",
        }
        hdrs = {
            "authorization": token,
            "content-type": "application/json",
            "menulink": json.dumps({
                "menuId": "21980",
                "pgmId": "100001279",
                "pgmUrl": f"{TRB_BASE}/trb/pages/fra/TRBFRA053U",
            }),
            "x-requested-with": "XMLHttpRequest",
            "referer": f"{TRB_BASE}/trb/pages/fra/TRBFRA053U",
            "origin": TRB_BASE,
        }
        async with httpx.AsyncClient(verify=False, timeout=30.0) as c:
            res = await c.get(
                f"{TRB_BASE}/trb/fra/partnerpcadprgsprss",
                headers=hdrs,
                params={
                    "filter": json.dumps(filter_obj, ensure_ascii=False),
                    "_": int(time.time() * 1000),
                },
            )
        if res.status_code != 200:
            raise HTTPException(
                502, f"사고화물 조회 실패 (HTTP {res.status_code}): {res.text[:300]}"
            )
        data = res.json()
        return data if isinstance(data, list) else []

    @router.get("/invoices")
    def list_invoices(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT inv_no, created_at, memo FROM accident_invoices ORDER BY created_at ASC"
        ).fetchall()
        conn.close()
        return {"items": [
            {"invNo": r["inv_no"], "createdAt": r["created_at"], "memo": r["memo"] or ""}
            for r in rows
        ]}

    @router.post("/invoices")
    def add_invoice(
        inv_no: str = Body(...),
        memo: str = Body(""),
        user: str = Depends(get_current_user),
    ):
        inv_no = inv_no.strip()
        if not inv_no:
            raise HTTPException(400, "송장번호를 입력하세요")
        conn = get_db()
        conn.execute(
            "INSERT OR IGNORE INTO accident_invoices (inv_no, created_at, memo) VALUES (?, ?, ?)",
            (inv_no, datetime.now(timezone.utc).isoformat(), (memo or "").strip()),
        )
        conn.commit()
        conn.close()
        return {"ok": True, "inv_no": inv_no}

    @router.patch("/invoices/{inv_no}")
    def update_invoice_memo(
        inv_no: str,
        memo: str = Body("", embed=True),
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        conn.execute(
            "UPDATE accident_invoices SET memo = ? WHERE inv_no = ?",
            ((memo or "").strip(), inv_no),
        )
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.delete("/invoices/{inv_no}")
    def delete_invoice(inv_no: str, user: str = Depends(get_current_user)):
        conn = get_db()
        conn.execute("DELETE FROM accident_invoices WHERE inv_no = ?", (inv_no,))
        conn.commit()
        conn.close()
        return {"ok": True}

    @router.get("/completed")
    def list_completed(user: str = Depends(get_current_user)):
        conn = get_db()
        rows = conn.execute(
            "SELECT inv_no, acper_nm, gds_amt, agr_amt, acd_prgs_sct_cd, completed_at"
            " FROM accident_completed ORDER BY completed_at ASC"
        ).fetchall()
        conn.close()
        return {"items": [
            {
                "invNo": r["inv_no"],
                "acperNm": r["acper_nm"],
                "gdsAmt": r["gds_amt"],
                "agrAmt": r["agr_amt"],
                "acdPrgsSctCd": r["acd_prgs_sct_cd"],
                "completedAt": r["completed_at"],
            }
            for r in rows
        ]}

    @router.post("/fetch")
    async def fetch_accident(
        date_fr: str = Body(...),
        date_to: str = Body(...),
        user: str = Depends(get_current_user),
    ):
        conn = get_db()
        rows = conn.execute("SELECT inv_no FROM accident_invoices").fetchall()
        conn.close()
        inv_set = {r["inv_no"] for r in rows}

        token = await _login()
        all_data = await _fetch_accident_data(token, date_fr, date_to)

        yusaek = [item for item in all_data if item.get("snperNm") == "유색"]

        matched: list[dict] = []
        matched_inv: set[str] = set()
        now = datetime.now(timezone.utc).isoformat()
        for item in yusaek:
            inv = str(item.get("invNo", "")).strip()
            if inv in inv_set:
                matched_inv.add(inv)
                matched.append({
                    "invNo": inv,
                    "agrAmt": item.get("agrAmt"),
                    "gdsAmt": item.get("gdsAmt"),
                    "acperNm": item.get("acperNm"),
                    "acdPrgsSctCd": item.get("acdPrgsSctCd"),
                    "completedAt": now,
                })

        if matched_inv:
            conn = get_db()
            for m in matched:
                conn.execute(
                    "INSERT OR REPLACE INTO accident_completed"
                    " (inv_no, acper_nm, gds_amt, agr_amt, acd_prgs_sct_cd, completed_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        m["invNo"],
                        str(m["acperNm"] or ""),
                        str(m["gdsAmt"] or ""),
                        str(m["agrAmt"] or ""),
                        str(m["acdPrgsSctCd"] or ""),
                        now,
                    ),
                )
                conn.execute(
                    "DELETE FROM accident_invoices WHERE inv_no = ?", (m["invNo"],)
                )
            conn.commit()
            conn.close()

        return {
            "ok": True,
            "total_yusaek": len(yusaek),
            "matched": matched,
            "unmatched": list(inv_set - matched_inv),
        }

    return router
