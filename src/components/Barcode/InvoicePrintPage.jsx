import { useCallback, useEffect, useMemo, useState } from "react";
import { useEzadminSession } from "../../lib/EzadminSessionContext";
import pageStyles from "./BarcodePage.module.css";
import { LOCAL_API_BASE as API, getAuthHeaders, handleUnauthorized } from "../../lib/api";

function dateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DEFAULT_FILTERS = {
  start_date: dateStr(-91),
  end_date: dateStr(0),
  shop_code: "10028",
  product_type: "name",
  product_text: "",
  part_trans: true,
  part_count: "",
  order_reserve: true,
  priority_deliv: true,
};

const STATUS_LABEL = { pending: "대기", issuing: "발급 중", issued: "출력됨", done: "완료" };

export default function InvoicePrintPage({ headerExtra = null }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [splitMode, setSplitMode] = useState("pc"); // pc: PC 대수로 균등 분할, size: 구간당 건수
  const [pcCount, setPcCount] = useState(2);
  const [chunkSize, setChunkSize] = useState(300);
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState("");
  const [jobRows, setJobRows] = useState([]); // 선택한 작업의 주문 목록 (구간 상태와 별도로 한 번만 받는다)
  const [viewChunk, setViewChunk] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { openModal: openEzadminModal } = useEzadminSession();

  const call = useCallback(async (path, method = "GET", body = null) => {
    const res = await fetch(`${API}/invoice-print${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (handleUnauthorized(res)) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || "요청 실패");
    return data;
  }, []);

  const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));

  const refreshJobs = useCallback(async () => {
    try {
      const data = await call("/jobs");
      if (data?.ok) setJobs(data.jobs);
    } catch {
      /* 다음 주기에 다시 시도 */
    }
  }, [call]);

  const openJob = useCallback(async (id) => {
    setJobId(id);
    setViewChunk(0);
    if (!id) { setJobRows([]); return; }
    refreshJobs();
    try {
      const data = await call(`/jobs/${id}`);
      if (data?.ok) setJobRows(data.job.rows);
    } catch (err) {
      setMessage(err.message || "작업 조회 실패");
    }
  }, [call, refreshJobs]);

  // 실시간 갱신은 하지 않고, 화면을 열 때와 이 창으로 돌아올 때만 다른 PC의 진행 상황을 반영한다.
  useEffect(() => {
    refreshJobs();
    window.addEventListener("focus", refreshJobs);
    return () => window.removeEventListener("focus", refreshJobs);
  }, [refreshJobs]);

  const job = useMemo(() => jobs.find((j) => j.id === jobId) || null, [jobs, jobId]);
  const chunk = job?.chunks?.[viewChunk] || null;
  const chunkRows = useMemo(() => {
    if (!job || !chunk) return [];
    return jobRows.slice(chunk.start - 1, chunk.end);
  }, [job, chunk, jobRows]);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setMessage("이지어드민에서 주문을 불러오는 중입니다. 건수가 많으면 1분 이상 걸릴 수 있습니다.");
    try {
      const body = { ...filters };
      if (splitMode === "size") body.chunk_size = Number(chunkSize) || 1;
      else body.pc_count = Number(pcCount) || 1;
      const data = await call("/jobs", "POST", body);
      if (!data) return;
      if (data.need_session) {
        openEzadminModal(handleCreate);
        return;
      }
      if (!data.ok) {
        setMessage(data.detail || "검색 실패");
        return;
      }
      await refreshJobs();
      setJobId(data.job.id);
      setJobRows(data.job.rows);
      setViewChunk(0);
      setMessage(`${data.job.total}건을 불러왔습니다. 다른 PC에서도 '작업 선택'에서 이 작업을 열 수 있습니다.`);
    } catch (err) {
      setMessage(err.message || "검색 실패");
    } finally {
      setBusy(false);
    }
  }, [filters, splitMode, chunkSize, pcCount, call, refreshJobs, openEzadminModal]);

  const writePrintWindow = (win, html) => {
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 1000);
  };

  const handlePrint = async (c) => {
    const ok = window.confirm(
      `${c.start}~${c.end}번 구간 ${c.pending_count}건의 송장번호를 발급하고 출력합니다.\n송장번호 발급은 되돌릴 수 없습니다. 계속할까요?`
    );
    if (!ok) return;
    // 팝업 차단을 피하려고 클릭 직후 동기적으로 창을 먼저 연다.
    const win = window.open("", "_blank");
    if (!win) { setMessage("팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요."); return; }
    win.document.write("<p style='font-family:sans-serif'>송장 생성 중...</p>");
    setBusy(true);
    setMessage("송장번호를 발급하는 중입니다...");
    try {
      const data = await call(`/jobs/${jobId}/chunks/${c.no}/print`, "POST");
      if (!data) { win.close(); return; }
      if (data.need_session) { win.close(); openEzadminModal(() => handlePrint(c)); return; }
      if (!data.ok) { win.close(); setMessage(data.detail || "송장 출력 실패"); return; }
      writePrintWindow(win, data.html);
      setMessage(`${data.count}건 송장 출력 창을 열었습니다. 인쇄가 끝나면 '출력 완료'를 눌러 주세요.`);
    } catch (err) {
      win.close();
      setMessage(err.message || "송장 출력 실패");
    } finally {
      setBusy(false);
      refreshJobs();
    }
  };

  const handleReprint = async (c) => {
    const win = window.open("", "_blank");
    if (!win) { setMessage("팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요."); return; }
    win.document.write("<p style='font-family:sans-serif'>송장 불러오는 중...</p>");
    setBusy(true);
    try {
      const data = await call(`/jobs/${jobId}/chunks/${c.no}/reprint`, "POST");
      if (!data) { win.close(); return; }
      if (data.need_session) { win.close(); openEzadminModal(() => handleReprint(c)); return; }
      writePrintWindow(win, data.html);
      setMessage("송장번호를 새로 발급하지 않고 같은 송장을 다시 열었습니다.");
    } catch (err) {
      win.close();
      setMessage(err.message || "재출력 실패");
    } finally {
      setBusy(false);
    }
  };

  const handleDone = async (c) => {
    setBusy(true);
    try {
      const data = await call(`/jobs/${jobId}/chunks/${c.no}/done`, "POST");
      if (!data) return;
      if (data.need_session) { openEzadminModal(() => handleDone(c)); return; }
      setMessage(data.ok ? `${c.start}~${c.end}번 구간을 출력 완료 처리했습니다.` : data.detail || "출력 완료 처리 실패");
    } catch (err) {
      setMessage(err.message || "출력 완료 처리 실패");
    } finally {
      setBusy(false);
      refreshJobs();
    }
  };

  const handleRelease = async (c) => {
    if (!window.confirm("발급 중에 멈춘 구간만 풀어 주세요. 다른 PC가 지금 출력 중이면 중복 발급될 수 있습니다. 풀까요?")) return;
    try {
      await call(`/jobs/${jobId}/chunks/${c.no}/release`, "POST");
    } catch (err) {
      setMessage(err.message || "풀기 실패");
    }
    refreshJobs();
  };

  const handleDelete = async () => {
    if (!job || !window.confirm("이 작업을 목록에서 삭제할까요? (이미 발급된 송장은 그대로 유지됩니다)")) return;
    try {
      await call(`/jobs/${job.id}`, "DELETE");
      setJobId("");
      setJobRows([]);
    } catch (err) {
      setMessage(err.message || "삭제 실패");
    }
    refreshJobs();
  };

  const me = localStorage.getItem("username") || "";
  const issuedCount = job ? job.chunks.filter((c) => c.status === "issued" || c.status === "done").reduce((n, c) => n + c.count, 0) : 0;

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHeader}>
        <div>
          <h2 className={pageStyles.title}>송장출력</h2>
          <p className={pageStyles.subtitle}>검색 → 작업 저장 → 여러 PC가 구간을 나눠 출력 (누가 출력한 구간은 다른 PC에서 비활성화)</p>
        </div>
        {headerExtra}
      </div>

      <div className={pageStyles.stack}>
        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>1. 검색</h3>
            <div className={pageStyles.headerActions}>
              <button className={pageStyles.secondaryBtn} onClick={() => setFilters(DEFAULT_FILTERS)} disabled={busy}>
                조건 초기화
              </button>
              <button className={pageStyles.primaryBtn} onClick={handleCreate} disabled={busy}>
                {busy ? "처리 중..." : "검색 (새 작업 만들기)"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 1.25rem", alignItems: "center" }}>
            <label>
              기간{" "}
              <input className={pageStyles.dateInput} type="date" value={filters.start_date} onChange={(e) => setFilter("start_date", e.target.value)} />
              {" ~ "}
              <input className={pageStyles.dateInput} type="date" value={filters.end_date} onChange={(e) => setFilter("end_date", e.target.value)} />
            </label>
            <label>
              거래처 코드{" "}
              <input className={pageStyles.dateInput} style={{ width: "6rem" }} value={filters.shop_code} onChange={(e) => setFilter("shop_code", e.target.value)} />
            </label>
            <label>
              상품{" "}
              <select className={pageStyles.dateInput} value={filters.product_type} onChange={(e) => setFilter("product_type", e.target.value)}>
                <option value="name">상품명</option>
                <option value="code">상품코드</option>
              </select>{" "}
              <input className={pageStyles.dateInput} style={{ width: "10rem" }} value={filters.product_text} onChange={(e) => setFilter("product_text", e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={filters.part_trans} onChange={(e) => setFilter("part_trans", e.target.checked)} /> 부분배송
            </label>
            <label style={{ opacity: filters.part_trans ? 1 : 0.5 }}>
              부분배송 수량{" "}
              <input
                className={pageStyles.dateInput}
                style={{ width: "4rem" }}
                type="number"
                min="0"
                disabled={!filters.part_trans}
                value={filters.part_count}
                onChange={(e) => setFilter("part_count", e.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={filters.order_reserve} onChange={(e) => setFilter("order_reserve", e.target.checked)} /> 예약발주
            </label>
            <label>
              <input type="checkbox" checked={filters.priority_deliv} onChange={(e) => setFilter("priority_deliv", e.target.checked)} /> 우선배송
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 1.25rem", alignItems: "center", marginTop: "0.75rem" }}>
            <strong>구간 나누기</strong>
            <label>
              <input type="radio" checked={splitMode === "pc"} onChange={() => setSplitMode("pc")} /> PC{" "}
              <input
                className={pageStyles.dateInput}
                style={{ width: "4rem" }}
                type="number"
                min="1"
                value={pcCount}
                disabled={splitMode !== "pc"}
                onChange={(e) => setPcCount(e.target.value)}
              />{" "}
              대로 균등 분할
            </label>
            <label>
              <input type="radio" checked={splitMode === "size"} onChange={() => setSplitMode("size")} /> 구간당{" "}
              <input
                className={pageStyles.dateInput}
                style={{ width: "5rem" }}
                type="number"
                min="1"
                value={chunkSize}
                disabled={splitMode !== "size"}
                onChange={(e) => setChunkSize(e.target.value)}
              />{" "}
              건
            </label>
          </div>
        </section>

        <section className={pageStyles.card}>
          <div className={pageStyles.cardHeader}>
            <h3 className={pageStyles.cardTitle}>2. 작업 선택 (모든 PC에서 공유)</h3>
            <div className={pageStyles.headerActions}>
              <select className={pageStyles.dateInput} value={jobId} onChange={(e) => openJob(e.target.value)}>
                <option value="">작업을 선택하세요</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title} (출력 {j.done_count}/{j.total})
                  </option>
                ))}
              </select>
              <button className={pageStyles.secondaryBtn} onClick={refreshJobs}>새로고침</button>
              <button className={pageStyles.secondaryBtn} onClick={handleDelete} disabled={!job}>작업 삭제</button>
            </div>
          </div>
          {job ? (
            <p>
              총 {job.total.toLocaleString()}건 · 구간 {job.chunks.length}개 · 출력됨 {issuedCount.toLocaleString()}건 · 생성 {job.created_by}
            </p>
          ) : (
            <p style={{ opacity: 0.7 }}>최근 3일 안에 만든 작업이 표시됩니다. 다른 PC에서 만든 작업도 여기에서 열 수 있습니다.</p>
          )}
        </section>

        {job && (
          <section className={pageStyles.card}>
            <div className={pageStyles.cardHeader}>
              <h3 className={pageStyles.cardTitle}>3. 구간별 송장출력</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {job.chunks.map((c, i) => (
                <div
                  key={c.no}
                  style={{
                    display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", padding: "0.5rem 0.75rem",
                    border: "1px solid var(--border, #ddd)", borderRadius: "8px", background: i === viewChunk ? "rgba(0,0,0,0.04)" : "transparent",
                  }}
                >
                  <button className={pageStyles.secondaryBtn} onClick={() => setViewChunk(i)}>
                    {c.start}~{c.end} ({c.count}건)
                  </button>
                  <span>
                    {STATUS_LABEL[c.status] || c.status}
                    {c.claimed_by ? ` · ${c.claimed_by}${c.claimed_by === me ? " (나)" : ""}` : ""}
                    {c.pending_count !== c.count ? ` · 기존 발급 ${c.count - c.pending_count}건 제외` : ""}
                  </span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
                    {c.status === "pending" && (
                      <button className={pageStyles.primaryBtn} onClick={() => handlePrint(c)} disabled={busy || c.pending_count === 0}>
                        송장출력
                      </button>
                    )}
                    {(c.status === "issued" || c.status === "done") && (
                      <button className={pageStyles.secondaryBtn} onClick={() => handleReprint(c)} disabled={busy}>
                        다시 열기
                      </button>
                    )}
                    {c.status === "issued" && (
                      <button className={pageStyles.primaryBtn} onClick={() => handleDone(c)} disabled={busy}>
                        출력 완료
                      </button>
                    )}
                    {c.status === "issuing" && (
                      <button className={pageStyles.secondaryBtn} onClick={() => handleRelease(c)}>
                        멈춘 구간 풀기
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {job && chunk && (
          <section className={pageStyles.card}>
            <div className={pageStyles.cardHeader}>
              <h3 className={pageStyles.cardTitle}>{chunk.start}~{chunk.end}번 리스트</h3>
            </div>
            <div style={{ maxHeight: "24rem", overflow: "auto" }}>
              <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left">주문번호</th>
                    <th align="left">수령자</th>
                    <th align="left">주소</th>
                    <th align="left">상품</th>
                  </tr>
                </thead>
                <tbody>
                  {chunkRows.map((r) => (
                    <tr key={r.seq}>
                      <td>{r.seq}</td>
                      <td>{r.recv_name}</td>
                      <td>{r.recv_address}</td>
                      <td>{r.products}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {message && <p>{message}</p>}
      </div>
    </div>
  );
}
