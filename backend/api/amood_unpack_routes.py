from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException

from sdk.ezadmin import EzAdminClient, EzAdminSessionExpired, first_present

_LOOKBACK_DAYS = 90


def _is_ok(res: dict) -> bool:
    return isinstance(res, dict) and str(res.get("error", "")) == "0"


def build_amood_unpack_router(*, get_current_user, get_setting):
    router = APIRouter(prefix="/amood-unpack")

    @router.post("/run")
    async def run(payload: dict = Body(...), user: str = Depends(get_current_user)):
        """주문번호 하나를 합포에서 빼내 배송취소하고, 남은 합포는 보류해제 후 배송처리한다.

        순서(실캡처 기준): cancel_trans(대상) -> drop_pack(대상) -> 남은 합포 재조회 ->
        cancel_hold(남은 합포, 보류 상태일 때만) -> confirm_trans(남은 합포).
        변경 작업 전에 합포 구성을 전부 검증하고, 중간 단계가 실패하면 거기서 멈춰
        steps에 진행 상황을 담아 돌려준다."""
        order_id = str(payload.get("order_id") or "").strip()
        if not order_id:
            raise HTTPException(status_code=400, detail="주문번호를 입력해주세요.")

        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
        ez = EzAdminClient(get_setting)
        steps: list[dict] = []

        def fail(step: str, detail: str):
            steps.append({"step": step, "ok": False, "detail": detail})
            return {"ok": False, "order_id": order_id, "error": f"{step} 실패: {detail}", "steps": steps}

        try:
            rows = await ez.query_orders(order_id, start_date=start_date, end_date=end_date, rows=10)
            pack = None
            for row in rows:
                cell = row.get("cell") if isinstance(row, dict) else None
                pack = first_present(cell or row, ("pack",))
                if pack:
                    break
            if not pack:
                return {"ok": False, "order_id": order_id, "error": "이지어드민에서 주문을 찾지 못했습니다.", "steps": []}

            items = await ez.packlist_items(str(pack))
            target = [it for it in items if str(it.get("order_id") or "").strip() == order_id]
            if not target:
                return {"ok": False, "order_id": order_id, "error": f"합포 {pack} 안에서 해당 주문번호를 찾지 못했습니다.", "steps": []}
            # 한 주문번호가 상품 여러 개로 여러 seq에 걸릴 수 있다(실캡처: 704623, 704624).
            # 배송취소는 합포 단위라 seq 하나로 한 번만 호출하고, 합포제외는 전 상품을 한 번에 넘긴다.
            target_seqs = sorted({str(it.get("seq")) for it in target})
            cancel_seq = target_seqs[0]
            remaining = [it for it in items if str(it.get("seq")) not in target_seqs]
            if not remaining:
                return {"ok": False, "order_id": order_id, "error": "합포가 아닌 단독 주문입니다 (제외할 대상이 없음).", "steps": []}
            remaining_order_id = str(remaining[0].get("order_id") or "").strip()
            prd_seqs = [str(it.get("prd_seq")) for it in target if it.get("prd_seq")]
            if not prd_seqs or not remaining_order_id:
                return {"ok": False, "order_id": order_id, "error": "상품(prd_seq) 정보를 읽지 못해 중단합니다.", "steps": []}

            res = await ez.cancel_trans(cancel_seq)
            if not _is_ok(res):
                return fail("배송취소", str(res))
            steps.append({"step": "배송취소", "ok": True, "detail": f"seq {cancel_seq}"})

            res = await ez.drop_pack(prd_seqs)
            if not _is_ok(res):
                return fail("합포제외", str(res))
            steps.append({"step": "합포제외", "ok": True, "detail": f"분리된 seq {res.get('drop_seq_list')}"})

            # 처음 조회해 둔 합포번호(pack)로 재검색한다. 대상 중에 합포 대표(seq == pack)가 있었다면
            # 제외 후 합포번호가 바뀌므로 그때만 남은 주문번호로 검색한다.
            search_key = remaining_order_id if str(pack) in target_seqs else str(pack)
            rows = await ez.query_orders(search_key, start_date=start_date, end_date=end_date, rows=10)
            cell = ((rows[0].get("cell") if rows and isinstance(rows[0], dict) else None) or {}) if rows else {}
            new_pack = str(cell.get("pack") or "").strip()
            if not new_pack:
                return fail("남은 합포 조회", f"{search_key}로 합포를 찾지 못함")
            steps.append({"step": "남은 합포 조회", "ok": True, "detail": f"pack {new_pack}"})

            if str(cell.get("hold") or "0") not in ("", "0"):
                res = await ez.cancel_hold(new_pack)
                if not _is_ok(res):
                    return fail("보류해제", str(res))
                steps.append({"step": "보류해제", "ok": True, "detail": f"pack {new_pack}"})
            else:
                steps.append({"step": "보류해제", "ok": True, "detail": "보류 상태 아님 - 생략"})

            res = await ez.confirm_trans(new_pack)
            if not _is_ok(res):
                return fail("배송처리", str(res))
            steps.append({"step": "배송처리", "ok": True, "detail": f"pack {new_pack}"})
        except EzAdminSessionExpired:
            return {"ok": False, "need_ezadmin_session": True, "order_id": order_id, "steps": steps}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"이지어드민 처리 실패: {exc} (진행: {[s['step'] for s in steps]})")

        return {"ok": True, "order_id": order_id, "target_seqs": target_seqs, "pack": new_pack, "steps": steps}

    return router
