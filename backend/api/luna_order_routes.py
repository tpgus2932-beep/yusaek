from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from services import luna_order_template as luna


def build_luna_order_router(*, get_current_user, get_shared_db):
    router = APIRouter(prefix="/luna-order", tags=["luna-order"])

    @router.get("/template-rows")
    def template_rows(q: str = "", limit: int = 50, user: str = Depends(get_current_user)):
        """수동 매칭 UI용 - 양식의 품목코드/상품명(C열)/옵션명(D열)을 검색한다."""
        limit = max(1, min(limit, 200))
        # 공백으로 나눈 단어가 전부 들어 있으면 매칭(순서 무관) - "8015 브라운"처럼 검색한다.
        terms = q.lower().split()
        rows = []
        for r in luna.load_template_rows():
            haystack = f"{r['code']} {r['name']} {r['option']}".lower()
            if not all(t in haystack for t in terms):
                continue
            rows.append(r)
            if len(rows) >= limit:
                break
        return {"ok": True, "rows": rows}

    @router.get("/mappings")
    def mappings(user: str = Depends(get_current_user)):
        return {"ok": True, "mappings": luna.list_mappings(get_shared_db)}

    @router.put("/mappings")
    def put_mapping(payload: dict = Body(...), user: str = Depends(get_current_user)):
        yusas_code = str(payload.get("yusas_code") or "").strip()
        name = str(payload.get("template_name") or "").strip()
        if not yusas_code or not name:
            raise HTTPException(status_code=400, detail="yusas_code와 template_name이 필요합니다.")
        luna.save_mapping(
            get_shared_db,
            yusas_code=yusas_code,
            template_code=payload.get("template_code") or "",
            template_name=name,
            template_option=payload.get("template_option") or "",
            user=user,
        )
        return {"ok": True}

    @router.delete("/mappings/{yusas_code}")
    def remove_mapping(yusas_code: str, user: str = Depends(get_current_user)):
        luna.delete_mapping(get_shared_db, yusas_code)
        return {"ok": True}

    @router.post("/resolve")
    def resolve(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """items[{yusas_code, qty, ...}] 중 저장된 매칭이 있는 것과 없는 것을 나눠서 돌려준다."""
        result = luna.resolve_items(get_shared_db, payload.get("items") or [])
        return {"ok": True, **result}

    @router.post("/export")
    def export(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """매칭된 항목만 양식 E열에 합산해서 채운 엑셀을 내려준다. 매칭 안 된 항목은 건너뛰고
        건수만 헤더로 알린다 - 프론트는 보통 resolve로 먼저 다 매칭시킨 뒤 호출한다."""
        result = luna.resolve_items(get_shared_db, payload.get("items") or [])
        data = luna.build_workbook(result["matched"])
        filename = quote(f"루나앤솔_주문_{luna.now_kst_iso()[:10].replace('-', '')}.xlsx")
        return Response(
            content=data,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
                "X-Unmatched-Count": str(len(result["unmatched"])),
                "Access-Control-Expose-Headers": "X-Unmatched-Count, Content-Disposition",
            },
        )

    return router
