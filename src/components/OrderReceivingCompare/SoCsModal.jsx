import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCheck, Send, X } from "lucide-react";
import styles from "./SoCsModal.module.css";
import { LOCAL_API_BASE, getAuthHeaders, handleUnauthorized } from "../../lib/api";

// C/S 메뉴와 같은 서버 API 를 그대로 쓴다 → 여기서 답변/완료하면 C/S 메뉴에도 그대로 반영된다.
const call = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(`${LOCAL_API_BASE}/cs${path}`, {
    method,
    headers: { ...getAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (handleUnauthorized(res)) throw new Error("로그인이 만료되었습니다.");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "요청에 실패했습니다.");
  return data;
};

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 한국어 키보드의 오른쪽 Ctrl 은 한자 키로 들어와 ctrlKey 가 false 일 수 있다 (C/S 메뉴와 같은 처리)
const isRightCtrlKey = (e) => e.code === "ControlRight" || e.code === "Lang2" || e.key === "Hanja" || e.key === "HanjaMode";

/**
 * 상품(상품코드)에 걸린 C/S 를 가볍게 보고 처리하는 작은 창.
 *  1) 문의 요약 목록  2) 목록에서 고르면 대화 + 답변창(전송 / 완료 처리)
 * rooms: 이 상품코드의 진행 중 문의 요약, delays: 악성지연 주문(읽기 전용)
 */
export default function SoCsModal({ title, option, rooms, delays, onClose, onChanged }) {
  const [sel, setSel] = useState(null); // 고른 문의 요약
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const msgsRef = useRef(null);
  const replyRef = useRef(null);
  const rightCtrl = useRef(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const room = detail?.contact_room;
  const messages = (detail?.contact_messages || []).filter((m) => m.content || m.image_url || m.order_item?.goods);
  const canComplete = Boolean(room && [1, 2].includes(room.status));

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [detail]);
  useEffect(() => {
    if (detail && !acting && replyRef.current) replyRef.current.focus();
  }, [detail, acting]);

  const openRoom = async (r) => {
    setSel(r);
    setDetail(null);
    setDraft("");
    setError("");
    setLoading(true);
    try {
      setDetail(await call(`/rooms/${r.sno}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  const back = () => { setSel(null); setDetail(null); setDraft(""); setError(""); };

  const send = async () => {
    const text = draft.trim();
    if (!text || acting || !sel) return;
    setActing(true);
    setError("");
    try {
      const data = await call(`/rooms/${sel.sno}/reply`, { method: "POST", body: { content: text } });
      setDetail(data.detail);
      setDraft("");
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };
  const complete = async () => {
    if (acting || !sel || !canComplete) return;
    setActing(true);
    setError("");
    try {
      await call(`/rooms/${sel.sno}/complete`, { method: "POST" });
      onChanged?.();
      back(); // 완료한 문의는 목록에서 빠진다
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };

  const onKeyDown = (e) => {
    if (isRightCtrlKey(e)) { rightCtrl.current = true; return; }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || rightCtrl.current) complete();
    else send();
  };

  const delayList = delays || [];
  return (
    <div className={styles.back} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          {sel && <button type="button" className={styles.iconBtn} onClick={back} title="목록으로"><ArrowLeft size={16} /></button>}
          <div className={styles.headText}>
            <div className={styles.title}>{sel ? (sel.name || "고객") : title}</div>
            <div className={styles.sub}>{sel ? [sel.category, title].filter(Boolean).join(" · ") : option}</div>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="닫기"><X size={16} /></button>
        </div>

        {!sel && (
          <div className={styles.body}>
            {rooms.length === 0 && delayList.length === 0 && <div className={styles.empty}>처리할 C/S가 없어요</div>}
            {rooms.length > 0 && <div className={styles.count}>진행 중 문의 {rooms.length}건</div>}
            <div className={styles.list}>
            {rooms.map((r) => (
              <button key={r.sno} type="button" className={styles.room} onClick={() => openRoom(r)}>
                <span className={styles.rowTop}>
                  <b>{r.name || "고객"}</b>
                  {r.category && <span className={styles.cat}>{r.category}</span>}
                  <span className={`${styles.state} ${r.waiting ? styles.stateWait : styles.stateDone}`}>{r.waiting ? "미답변" : "답변함"}</span>
                  <span className={styles.time}>{fmtTime(r.at)}</span>
                </span>
                <span className={styles.preview}>{r.preview || "[사진 · 주문 메시지]"}</span>
              </button>
            ))}
            </div>
            {delayList.length > 0 && (
              <div className={styles.delayBox}>
                <div className={styles.delayHead}>악성지연 주문 {delayList.length}건 <span>· 확인용</span></div>
                {delayList.slice(0, 5).map((d) => (
                  <div key={d.order_sno} className={styles.delayRow}>
                    <span>{d.buyer || "구매자"}</span>
                    <span className={styles.muted}>{d.option}</span>
                    <span className={styles.delayDays}>{d.delay != null ? `${d.delay}일 지연` : ""}</span>
                  </div>
                ))}
                {delayList.length > 5 && <div className={styles.muted}>외 {delayList.length - 5}건</div>}
              </div>
            )}
          </div>
        )}

        {sel && (
          <div className={styles.body}>
            {loading && <div className={styles.empty}>불러오는 중…</div>}
            {detail && (
              <div className={styles.msgs} ref={msgsRef}>
                {messages.map((m) => {
                  const mine = m.member_type !== "USER";
                  return (
                    <div key={m.sno} className={`${styles.msg} ${mine ? styles.mine : ""} ${m.is_written_by_system ? styles.sys : ""}`}>
                      {m.content && <div className={styles.text}>{m.content}</div>}
                      {m.image_url && <img src={m.transformed_image_url || m.image_url} alt="" className={styles.img} />}
                      {!m.content && !m.image_url && m.order_item?.goods && <div className={styles.text}>[주문] {m.order_item.goods.name}</div>}
                      <div className={styles.msgTime}>{fmtTime(m.created_at)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {detail && (
              <div className={styles.reply}>
                <textarea
                  ref={replyRef}
                  rows={3}
                  value={draft}
                  readOnly={acting}
                  placeholder="답변 입력 · Enter 전송 · Shift+Enter 줄바꿈 · Ctrl+Enter 완료"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  onKeyUp={(e) => { if (isRightCtrlKey(e)) rightCtrl.current = false; }}
                  onBlur={() => { rightCtrl.current = false; }}
                />
                <div className={styles.actions}>
                  <button type="button" className={styles.btn} onMouseDown={(e) => e.preventDefault()} disabled={acting || !canComplete} onClick={complete}>
                    <CheckCheck size={14} /> 완료 처리
                  </button>
                  <button type="button" className={`${styles.btn} ${styles.primary}`} onMouseDown={(e) => e.preventDefault()} disabled={acting || !draft.trim()} onClick={send}>
                    <Send size={14} /> {acting ? "처리 중…" : "전송"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}
