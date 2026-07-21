from __future__ import annotations
import json, time
import httpx
from . import config

_RETURN_INVOICE_KEYS = (
    "returnInvoice", "return_invoice", "returnInvoiceNo", "return_invoice_no",
    "rtnInvNo", "rtn_inv_no", "returnInvNo", "return_inv_no", "반송장번호", "반송장",
)

def _find_return_invoice(value, original: str) -> str:
    if isinstance(value, dict):
        for key in _RETURN_INVOICE_KEYS:
            candidate = str(value.get(key) or "").strip()
            if candidate and candidate != str(original).strip():
                return candidate
        for child in value.values():
            found = _find_return_invoice(child, original)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_return_invoice(child, original)
            if found:
                return found
    return ""


class LLogisClient:
    def __init__(self, *, timeout: float = 15.0): self._timeout = timeout; self._token: str | None = None

    async def login(self, *, force: bool = False) -> str:
        if self._token and not force: return self._token
        async with httpx.AsyncClient(timeout=self._timeout, verify=False) as client:
            response = await client.post(config.LLOGIS_LOGIN_URL, json={"principal": config.LLOGIS_PRINCIPAL, "credential": config.LLOGIS_CREDENTIAL, "macAddress": "normal-browser"}, headers={"Content-Type": "application/json", "Origin": "https://partner.alps.llogis.com", "Referer": "https://partner.alps.llogis.com/", "User-Agent": "Mozilla/5.0"})
        response.raise_for_status(); token = response.json().get("accessToken")
        if not token: raise RuntimeError("llogis login failed")
        self._token = token; return token

    async def query_return_status(self, inv_no: str) -> dict:
        token = await self.login(); base = config.LLOGIS_PID_BASE
        params = {"filter": json.dumps({"srchInvNo": inv_no, "blngBrshCd": None, "empno": config.LLOGIS_EMP_NO, "usrId": config.LLOGIS_EMP_NO, "currPageId": "PIDFTR001U", "crdFarePrntStat": "N", "srchOrgInvNo": ""}, ensure_ascii=False), "_": str(int(time.time() * 1000))}
        headers = {"Accept": "application/json, text/javascript, */*; q=0.01", "Authorization": token, "Content-Type": "application/json", "Host": "pid.alps.llogis.com:18210", "Referer": f"{base}/pid/pages/ftr/PIDFTR051U", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0"}
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client: response = await client.get(f"{base}/pid/ftr/pacltrc/inner/bcraiinvinfo", params=params, headers=headers)
        if response.status_code != 200: return {"llogis_status": "-", "llogis_location": "-", "llogis_scan_date": "-", "llogis_return_invoice_no": ""}
        payload = response.json()
        latest = (payload.get("mvmList") or [])[-1:]
        row = latest[0] if latest else {}
        related_returns = [r for r in (payload.get("rltnInvList") or []) if str(r.get("wkSctCd") or "") == "02"]
        related_return = related_returns[0] if related_returns else {}
        return {"llogis_status": row.get("paclStatNm") or "-", "llogis_location": row.get("scanBrshNm") or "-", "llogis_scan_date": row.get("rgstYmd") or "-", "llogis_return_invoice_no": str(related_return.get("rltnInvNoView") or related_return.get("rltnInvNo") or _find_return_invoice(payload, inv_no) or "").strip()}

    async def query_accident_cargo(self, date_fr: str, date_to: str) -> dict:
        token = await self.login(); base = config.LLOGIS_TRB_BASE
        filter_obj = {"srchReqYmd": "requird:true", "srchCustSctCd": "10", "srchReqCustCd": "329673", "srchAcdTypCd": "10,20,30,40,50,60,90", "srchInvNo": "", "srchYmdFr": date_fr, "_STATUS_": "U", "srchYmdTo": date_to, "srchYmd": "A2.RGST_YMD", "srchNo": "A2.INV_NO"}
        headers = {"authorization": token, "content-type": "application/json", "referer": f"{base}/trb/pages/fra/TRBFRA053U", "origin": base, "x-requested-with": "XMLHttpRequest", "User-Agent": "Mozilla/5.0"}
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client: response = await client.get(f"{base}/trb/fra/partnerpcadprgsprss", headers=headers, params={"filter": json.dumps(filter_obj, ensure_ascii=False), "_": int(time.time() * 1000)})
        response.raise_for_status(); return response.json()
