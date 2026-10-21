import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from services import defect_tab


def _client():
    store = {t: {} for t in defect_tab.DEFECT_TABS}
    app = FastAPI()
    router = APIRouter(dependencies=[Depends(defect_tab.bind_defect_tab)])

    @router.post("/add")  # sync 엔드포인트(threadpool)로도 탭이 전파되는지
    def add():
        counts = store[defect_tab.current_tab()]
        counts["x"] = counts.get("x", 0) + 1
        return dict(counts)

    app.include_router(router)
    return TestClient(app), store


def test_tab_header_selects_separate_storage():
    client, store = _client()
    client.post("/add", headers={"X-Defect-Tab": "B"})
    client.post("/add", headers={"X-Defect-Tab": "B"})
    client.post("/add")  # 헤더 없음 -> A
    client.post("/add", headers={"X-Defect-Tab": "zzz"})  # 잘못된 값 -> A
    assert store == {"A": {"x": 2}, "B": {"x": 2}, "C": {}}
